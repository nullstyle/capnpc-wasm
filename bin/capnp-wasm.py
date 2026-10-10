#!/usr/bin/env python3
"""capnp-wasm.py: the portable launcher for the packaged Cap'n Proto compiler.

Runs the packaged compiler and WASI code generators under Wasmtime on Linux,
macOS, and Windows with Python 3.9 or newer and the standard library only. The
compiler and generator modes follow the same contract as bin/capnp-wasm (the
Bash launcher): read-only workspace copies, transactional generator output,
bounded guests, and the same exit statuses. This launcher also verifies the
package against its manifest.json before every run, and adds two modes that
take paths relative to the current directory: capnp and generate. Those modes
and their path translation are ported from capnp-zig's tools/capnp_tool.py
(the same author), which capnp-zig's CI ran on Linux, macOS, and Windows.
"""

import hashlib
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading

if sys.version_info < (3, 9):
    sys.stderr.write("capnp-wasm: Python 3.9 or newer is required\n")
    sys.exit(78)

WINDOWS = os.name == "nt"

USAGE = """usage: capnp-wasm.py compiler [--workspace ABS_DIR] -- CAPNP_ARGS...
       capnp-wasm.py generator --module ABS_WASM --output ABS_DIR -- GENERATOR_ARGS...
       capnp-wasm.py capnp -- CAPNP_ARGS...
       capnp-wasm.py generate (--module WASM | --plugin EXE) --output DIR
                     [--plugin-arg ARG]... -- SCHEMA_ARGS...
       capnp-wasm.py verify [--expect-manifest-sha256 HEX]
       capnp-wasm.py --help | --version"""

HELP = USAGE + """

compiler   runs the packaged capnp.wasm with a read-only copy of ABS_DIR as guest /.
           Without --workspace the guest sees an empty root, which is enough for
           convert, id, and --version.
generator  runs ABS_WASM with an empty staging directory as guest / and moves the
           generated files into ABS_DIR only after the generator exits 0.
capnp      runs the packaged compiler on paths relative to the current directory,
           like a native capnp: the deepest directory that holds the current
           directory and every path argument is guest /, the bundled schemas are
           added after your -I paths (unless --no-standard-import), and compile
           adds --src-prefix for the current directory. The guest reads that
           directory itself, not a copy.
generate   compiles SCHEMA_ARGS as capnp does (compile -o- is added; give no
           -o), runs a Wasm generator under Wasmtime (--module) or a native one
           (--plugin) on the request, and moves its files into DIR (created if
           missing) only after both succeed. --plugin-arg passes one generator
           argument; use --plugin-arg=--flag for one that starts with -.
verify     checks every packaged file against manifest.json and prints the
           manifest's sha256.

Every mode except --help and --version first verifies the package: each file
listed in manifest.json with its length and sha256, and no other file.
Arguments after -- and the standard streams pass through unchanged. The guest
environment is empty. Relative symlinks that stay inside the root are followed;
absolute symlinks and symlinks that leave the root are not.

environment:
  CAPNP_WASM_WASMTIME                 Wasmtime executable (default: wasmtime on PATH)
  CAPNP_WASM_WASMTIME_ACCEPT_VERSION  accept exactly this installed Wasmtime version
                                      instead of the packaged major.minor series
  CAPNP_WASM_TIMEOUT                  guest execution limit in seconds; 0 disables
                                      (default 300)
  CAPNP_WASM_MAX_MEMORY               guest linear memory limit in bytes
                                      (default 268435456; 16 MiB to 4 GiB)
  CAPNP_WASM_MAX_WORKSPACE            largest workspace copied for the compiler, in
                                      bytes of disk usage (default 268435456)
  CAPNP_WASM_EXPECT_MANIFEST_SHA256   require this sha256 of manifest.json, the
                                      digest a release publishes

exit status:
  0        success; other guest exit codes pass through unchanged
  64       launcher usage error
  65       --module is not a WebAssembly binary
  66       missing or unreadable workspace, output directory, module, or plugin
  69       Wasmtime executable not found or its version cannot be read
  70       the launcher cannot resolve its own location
  73       cannot stage the workspace, or cannot publish generator output
           (destination is a directory, symlink, read-only, or below a symlink,
           or the generator produced a symlink); a move that fails part-way
           keeps the staging directory and names it
  74       the package fails verification against its manifest.json
  78       Wasmtime version rejected, packaged runtime version missing, or an
           environment override is invalid
  134      Wasmtime trap: timeout, stack exhaustion, or a guest fault
  1        Wasmtime could not load or instantiate the module
  128+N    the launcher was stopped by signal N
Other failures of the launcher's own commands exit with status 1."""

MAX_WASM_STACK = 8388608
MAX_BACKTRACE = 16
MAX_ENTRIES = 65536
COMPILER_OPERATIONS = ("compile", "encode", "decode", "eval", "convert", "id")
INCLUDE_OPERATIONS = ("compile", "encode", "decode", "eval", "convert")


class Failure(Exception):
    """A launcher failure: an exit status and a message."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def fail(code, message):
    raise Failure(code, message)


def warn(message):
    sys.stderr.write("capnp-wasm: warning: " + message + "\n")
    sys.stderr.flush()


def package_root():
    try:
        return os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
    except OSError as error:
        fail(70, "cannot locate the package root: " + str(error))


def package_version(root):
    try:
        with open(os.path.join(root, "package.json"), "rb") as stream:
            version = json.load(stream).get("version")
        if isinstance(version, str) and version:
            return version
    except (OSError, ValueError):
        pass
    return "unknown"


# ---------------------------------------------------------------------------
# Package verification: manifest.json lists every other file with its length
# and sha256, as scripts/verify-release.ts checks it.


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def package_files(root):
    found = []
    for directory, subdirectories, files in os.walk(root):
        for name in list(subdirectories):
            path = os.path.join(directory, name)
            if os.path.islink(path) or is_junction(path):
                raise ValueError("package symlink is forbidden: " + relative_name(root, path))
        for name in files:
            path = os.path.join(directory, name)
            if os.path.islink(path):
                raise ValueError("package symlink is forbidden: " + relative_name(root, path))
            if not os.path.isfile(path):
                raise ValueError("unsupported package entry: " + relative_name(root, path))
            found.append(relative_name(root, path))
    return sorted(found)


def relative_name(root, path):
    return os.path.relpath(path, root).replace(os.sep, "/")


def is_junction(path):
    check = getattr(os.path, "isjunction", None)
    return bool(check and check(path))


def verify_package(root, expect=None):
    """Return (manifest, manifest sha256), or fail with 74."""
    manifest_path = os.path.join(root, "manifest.json")
    try:
        with open(manifest_path, "rb") as stream:
            raw = stream.read()
        manifest_digest = hashlib.sha256(raw).hexdigest()
        if expect is not None and manifest_digest != expect:
            raise ValueError(
                "manifest.json digest %s does not match the expected %s" % (manifest_digest, expect)
            )
        manifest = json.loads(raw.decode("utf-8"))
        entries = manifest.get("files")
        if manifest.get("format") != 1 or not isinstance(entries, list):
            raise ValueError("invalid release manifest")
        expected = {"manifest.json"}
        for entry in entries:
            path = entry.get("path") if isinstance(entry, dict) else None
            if (not isinstance(path, str) or "\\" in path or "\0" in path or
                    any(part in ("", ".", "..") for part in path.split("/")) or path in expected):
                raise ValueError("invalid or duplicate manifest path")
            size = entry.get("bytes")
            digest = entry.get("sha256")
            if (not isinstance(size, int) or isinstance(size, bool) or size < 0 or
                    not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest)):
                raise ValueError("invalid manifest digest: " + path)
            expected.add(path)
        actual = package_files(root)
        unexpected = [path for path in actual if path not in expected]
        missing = sorted(expected.difference(actual))
        if unexpected or missing:
            raise ValueError("package files do not match the manifest inventory (%s)" % ", ".join(
                ["unexpected " + path for path in unexpected[:4]] + ["missing " + path for path in missing[:4]]))
        for entry in entries:
            path = os.path.join(root, *entry["path"].split("/"))
            if os.path.getsize(path) != entry["bytes"] or sha256_file(path) != entry["sha256"]:
                raise ValueError("package integrity mismatch: " + entry["path"])
        try:
            with open(os.path.join(root, "package.json"), "rb") as stream:
                metadata = json.load(stream)
        except (OSError, ValueError):
            raise ValueError("package.json is missing or invalid")
        if metadata.get("name") != manifest.get("name") or metadata.get("version") != manifest.get("version"):
            raise ValueError("package identity does not match the manifest")
    except (OSError, ValueError, UnicodeDecodeError) as error:
        fail(74, "package verification failed: %s" % error)
    return manifest, manifest_digest


def expected_manifest_digest():
    value = os.environ.get("CAPNP_WASM_EXPECT_MANIFEST_SHA256", "")
    if value == "":
        return None
    value = value.lower()
    if not re.fullmatch(r"[0-9a-f]{64}", value):
        fail(78, "CAPNP_WASM_EXPECT_MANIFEST_SHA256 must be a sha256 in hex: " + value)
    return value


# ---------------------------------------------------------------------------
# Runtime requirement and environment overrides, in the Bash launcher's order.


class Settings:
    pass


def read_settings(root):
    settings = Settings()
    try:
        with open(os.path.join(root, "runtime", "wasmtime-version"), "r", encoding="utf-8") as stream:
            expected = stream.read().strip()
    except OSError:
        fail(78, "missing packaged runtime version")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", expected):
        fail(78, "invalid packaged runtime version")
    settings.expected_version = expected
    timeout = os.environ.get("CAPNP_WASM_TIMEOUT", "300")
    if not re.fullmatch(r"(0|[1-9][0-9]{0,5})", timeout):
        fail(78, "CAPNP_WASM_TIMEOUT must be a whole number of seconds (0 disables): " + timeout)
    settings.timeout = timeout
    memory = os.environ.get("CAPNP_WASM_MAX_MEMORY", "268435456")
    if not (re.fullmatch(r"[1-9][0-9]{0,9}", memory) and 16777216 <= int(memory) <= 4294967296):
        fail(78, "CAPNP_WASM_MAX_MEMORY must be a byte count from 16777216 to 4294967296: " + memory)
    settings.max_memory = memory
    workspace = os.environ.get("CAPNP_WASM_MAX_WORKSPACE", "268435456")
    if not re.fullmatch(r"[1-9][0-9]{0,11}", workspace):
        fail(78, "CAPNP_WASM_MAX_WORKSPACE must be a positive byte count: " + workspace)
    settings.max_workspace = int(workspace)
    accept = os.environ.get("CAPNP_WASM_WASMTIME_ACCEPT_VERSION", "")
    if accept and not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", accept):
        fail(78, "CAPNP_WASM_WASMTIME_ACCEPT_VERSION must be an exact X.Y.Z version: " + accept)
    settings.accept_version = accept
    return settings


def resolve_runtime(settings):
    """The absolute Wasmtime executable, checked against the packaged version."""
    expected = settings.expected_version
    requested = os.environ.get("CAPNP_WASM_WASMTIME", "wasmtime")
    separators = [os.sep] + ([os.altsep] if os.altsep else [])
    if any(separator in requested for separator in separators):
        runtime = os.path.abspath(requested)
        if not (os.path.isfile(runtime) and os.access(runtime, os.X_OK)):
            fail(69, "Wasmtime %s is required; executable not found: %s" % (expected, requested))
    else:
        runtime = shutil.which(requested)
        if runtime is None:
            fail(69, "Wasmtime %s is required; executable not found: %s" % (expected, requested))
        runtime = os.path.abspath(runtime)
    try:
        result = subprocess.run([runtime, "--version"], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    except (OSError, subprocess.SubprocessError):
        fail(69, "failed to read Wasmtime version")
    if result.returncode != 0:
        fail(69, "failed to read Wasmtime version")
    banner = result.stdout.decode("utf-8", "replace").strip().splitlines()
    banner = banner[0] if banner else ""
    match = re.fullmatch(r"wasmtime ([0-9]+\.[0-9]+\.[0-9]+)(?: .*)?", banner)
    if not match:
        fail(78, "expected Wasmtime %s, got: %s" % (expected, banner))
    actual = match.group(1)
    if actual != expected:
        actual_parts = [int(part) for part in actual.split(".")]
        expected_parts = [int(part) for part in expected.split(".")]
        if settings.accept_version and actual == settings.accept_version:
            warn("using Wasmtime %s instead of the packaged %s (CAPNP_WASM_WASMTIME_ACCEPT_VERSION)"
                 % (actual, expected))
        elif actual_parts[:2] == expected_parts[:2] and actual_parts[2] > expected_parts[2]:
            warn("using Wasmtime %s, a newer patch release than the packaged %s" % (actual, expected))
        else:
            fail(78, "expected Wasmtime %s (or a newer %s patch release), got: %s"
                 % (expected, expected.rsplit(".", 1)[0], banner))
    return runtime


# ---------------------------------------------------------------------------
# Filesystem roots and staging.


def is_absolute(path):
    if WINDOWS:
        drive, rest = os.path.splitdrive(path)
        return bool(drive) and rest[:1] in ("\\", "/")
    return path.startswith("/")


def is_filesystem_root(path):
    return os.path.dirname(path) == path


def resolve_root(kind, path):
    if not is_absolute(path) or "::" in path:
        fail(64, "%s must be an absolute path without ::: %s" % (kind, path))
    if not (os.path.isdir(path) and os.access(path, os.R_OK | os.X_OK)):
        fail(66, "%s is not an accessible directory: %s" % (kind, path))
    try:
        resolved = os.path.realpath(path)
    except OSError:
        fail(66, "%s cannot be resolved: %s" % (kind, path))
    if "::" in resolved:
        fail(64, "resolved %s contains ::: %s" % (kind, resolved))
    if is_filesystem_root(resolved):
        fail(64, "refusing to use the filesystem root as the " + kind)
    return resolved


def make_writable(path):
    try:
        mode = os.lstat(path).st_mode
        if not stat.S_ISLNK(mode):
            os.chmod(path, stat.S_IMODE(mode) | stat.S_IWUSR | (stat.S_IXUSR if stat.S_ISDIR(mode) else 0)
                     | stat.S_IRUSR)
    except OSError:
        pass


def remove_tree(path):
    """Remove a staging tree, write-protected or not."""
    if not path or not os.path.lexists(path):
        return

    def retry(function, target, _error):
        make_writable(os.path.dirname(target))
        make_writable(target)
        try:
            function(target)
        except OSError:
            pass

    for directory, subdirectories, _files in os.walk(path):
        make_writable(directory)
        for name in subdirectories:
            make_writable(os.path.join(directory, name))
    try:
        if sys.version_info >= (3, 12):
            shutil.rmtree(path, onexc=retry)
        else:
            shutil.rmtree(path, onerror=retry)
    except OSError:
        pass


class Cleanup:
    """Staging directories to remove when the launcher exits or is stopped."""

    def __init__(self):
        self.paths = []

    def add(self, path):
        self.paths.append(path)
        return path

    def keep(self, path):
        if path in self.paths:
            self.paths.remove(path)

    def run(self):
        while self.paths:
            remove_tree(self.paths.pop())


def make_stage(cleanup, parents, prefix):
    for parent in parents:
        try:
            created = tempfile.mkdtemp(prefix=prefix, dir=parent)
        except OSError:
            continue
        try:
            stage = os.path.realpath(created)
        except OSError:
            remove_tree(created)
            continue
        cleanup.add(stage)
        if "::" in stage:
            fail(73, "staging path contains ::: " + stage)
        return stage
    fail(73, "cannot create a staging directory next to " + str(parents[0]))


def count_entries(root, limit):
    count = 0
    for _directory, subdirectories, files in os.walk(root):
        count += len(subdirectories) + len(files)
        if count > limit:
            return count
    return count


def disk_usage(root):
    total = 0
    for directory, subdirectories, files in os.walk(root):
        for name in subdirectories + files:
            try:
                info = os.lstat(os.path.join(directory, name))
            except OSError:
                continue
            blocks = getattr(info, "st_blocks", None)
            total += blocks * 512 if blocks is not None else info.st_size
    return total


def write_protect(root):
    for directory, subdirectories, files in os.walk(root, topdown=False):
        for name in files:
            path = os.path.join(directory, name)
            if not os.path.islink(path):
                os.chmod(path, stat.S_IMODE(os.lstat(path).st_mode) & ~0o222)
        for name in subdirectories:
            path = os.path.join(directory, name)
            if not os.path.islink(path):
                os.chmod(path, stat.S_IMODE(os.lstat(path).st_mode) & ~0o222)
    os.chmod(root, stat.S_IMODE(os.lstat(root).st_mode) & ~0o222)


def warn_escaping_symlinks(root):
    """The guest cannot follow absolute symlinks or symlinks that leave its root."""
    shown = 0
    for directory, subdirectories, files in os.walk(root):
        for name in subdirectories + files:
            link = os.path.join(directory, name)
            if not os.path.islink(link):
                continue
            target = os.readlink(link)
            if os.path.isabs(target):
                reason = "absolute symlinks cannot be followed by the guest"
            else:
                resolved = os.path.realpath(link)
                if not os.path.exists(resolved):
                    continue  # A dangling link is reported by the guest if used.
                inside = resolved == root or resolved.startswith(root.rstrip(os.sep) + os.sep)
                if inside:
                    continue
                reason = "symlink leaves the workspace and cannot be followed by the guest"
            if shown < 8:
                warn("%s: %s -> %s" % (reason, relative_name(root, link), target))
            shown += 1
    if shown > 8:
        warn("%d more symlinks cannot be followed by the guest" % (shown - 8))


def stage_workspace(cleanup, settings, workspace):
    """Copy the workspace, write-protect the copy, and return the guest root."""
    stage = make_stage(cleanup, [tempfile.gettempdir()], "capnp-wasm.")
    root = os.path.join(stage, "root")
    if workspace is None:
        os.mkdir(root)
    else:
        workspace = resolve_root("workspace", workspace)
        home = os.environ.get("HOME") or os.environ.get("USERPROFILE")
        if home:
            try:
                if workspace == os.path.realpath(home):
                    warn("the workspace is your home directory; the guest receives a read-only copy of it")
            except OSError:
                pass
        if count_entries(workspace, MAX_ENTRIES) > MAX_ENTRIES:
            fail(73, "workspace has more than %d entries; point --workspace at the schema directory: %s"
                 % (MAX_ENTRIES, workspace))
        if disk_usage(workspace) > settings.max_workspace:
            fail(73, "workspace uses more than CAPNP_WASM_MAX_WORKSPACE=%d bytes of disk; point --workspace at "
                 "the schema directory: %s" % (settings.max_workspace, workspace))
        try:
            shutil.copytree(workspace, root, symlinks=True)
        except (OSError, shutil.Error):
            fail(73, "cannot copy the workspace into " + stage)
        warn_escaping_symlinks(workspace)
    try:
        write_protect(root)
    except OSError:
        fail(73, "cannot write-protect the workspace copy: " + root)
    return root


# ---------------------------------------------------------------------------
# Running a guest.


class Stopped(Exception):
    def __init__(self, number):
        super().__init__(number)
        self.number = number


def run_child(command, cwd, stdin=None, stdout=None, trap_scan=False, start_failure=69):
    """Run a child process, forward stop signals, and return its exit status.

    Background children ignore nothing here: SIGINT, SIGTERM, and SIGHUP are
    forwarded as SIGTERM, and the launcher then re-raises the signal itself.
    On Windows a trap is reported as exit 3, as is a guest exit 3, so stderr is
    scanned for Wasmtime's trap report and a trap becomes exit 134.
    """
    stop = []
    child = None
    previous = {}

    def forward(number, _frame):
        stop.append(number)
        if child is not None:
            try:
                child.terminate()
            except OSError:
                pass

    if not WINDOWS:
        for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            previous[number] = signal.signal(number, forward)
    trapped = []
    try:
        try:
            child = subprocess.Popen(command, cwd=cwd, stdin=stdin, stdout=stdout,
                                     stderr=subprocess.PIPE if trap_scan else None)
        except OSError as error:
            fail(start_failure, "cannot start %s: %s" % (os.path.basename(command[0]), error))
        if stop:
            try:
                child.terminate()
            except OSError:
                pass
        relay = None
        if trap_scan:
            def copy_stderr():
                tail = b""
                output = getattr(sys.stderr, "buffer", None)
                for block in iter(lambda: child.stderr.read1(65536) if hasattr(child.stderr, "read1")
                                  else child.stderr.read(65536), b""):
                    if output is not None:
                        output.write(block)
                        output.flush()
                    window = tail + block
                    if b"wasm trap" in window or b"wasm backtrace" in window:
                        trapped.append(True)
                    tail = window[-64:]
            relay = threading.Thread(target=copy_stderr, daemon=True)
            relay.start()
        while True:
            try:
                status = child.wait()
                break
            except KeyboardInterrupt:
                stop.append(signal.SIGINT)
                try:
                    child.terminate()
                except OSError:
                    pass
        if relay is not None:
            relay.join()
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)
    if stop:
        raise Stopped(stop[0])
    if status < 0:
        return 128 - status
    if WINDOWS and trap_scan and status == 3 and trapped:
        return 134
    return status


def run_guest(runtime, settings, module, root, argv0, arguments, stdin=None, stdout=None):
    bounds = ["-W", "max-wasm-stack=%d" % MAX_WASM_STACK, "-W", "max-memory-size=" + settings.max_memory]
    if settings.timeout != "0":
        bounds += ["-W", "timeout=%ss" % settings.timeout]
    directory, name = os.path.split(module)
    # Run from the module's directory so Wasmtime's own failure text names only
    # the module file, not the host installation path.
    command = [runtime, "run", "-W", "exceptions=y"] + bounds + [
        "-D", "max-backtrace=%d" % MAX_BACKTRACE, "-S", "cwd=/", "--dir", root + "::/",
        "--argv0=" + argv0, os.curdir + os.sep + name] + list(arguments)
    return run_child(command, directory, stdin=stdin, stdout=stdout, trap_scan=WINDOWS)


def check_module(module, relative_allowed=False):
    if relative_allowed:
        module = os.path.abspath(module)
    elif not is_absolute(module):
        fail(64, "module must be an absolute path: " + module)
    if not (os.path.isfile(module) and os.access(module, os.R_OK)):
        fail(66, "module is not a readable file: " + module)
    with open(module, "rb") as stream:
        if stream.read(4) != b"\0asm":
            fail(65, "module is not a WebAssembly binary: " + module)
    if "::" in os.path.dirname(module):
        fail(64, "module path contains ::: " + module)
    name = os.path.basename(module)
    argv0 = name[:-5] if name.endswith(".wasm") else name
    return module, argv0 or "generator"


def warn_zig_environment():
    if any(name.startswith("CAPNPC_ZIG_") for name in os.environ):
        warn("CAPNPC_ZIG_* variables are not passed to the guest; use capnpc-zig command-line options instead")


# ---------------------------------------------------------------------------
# Publishing staged generator output.


def symlink_in_path(output, relative):
    path = output
    for part in relative.split(os.sep):
        path = os.path.join(path, part)
        if os.path.islink(path) or is_junction(path):
            return path
    return None


def publish_output(cleanup, stage, output):
    entries = []
    for directory, subdirectories, files in os.walk(stage):
        for name in sorted(subdirectories) + sorted(files):
            entries.append(os.path.join(directory, name))
    entries.sort()
    for entry in entries:
        relative = os.path.relpath(entry, stage)
        destination = os.path.join(output, relative)
        bad = symlink_in_path(output, relative)
        if bad:
            fail(73, "output path is a symlink or below one: " + bad)
        if os.path.islink(entry) or is_junction(entry):
            fail(73, "generator produced a symlink: " + destination)
        if os.path.isdir(entry):
            if os.path.lexists(destination) and not (os.path.isdir(destination) and
                                                     os.access(destination, os.W_OK)):
                fail(73, "output directory conflicts with an existing entry: " + destination)
        elif os.path.isfile(entry):
            if os.path.isdir(destination):
                fail(73, "output file conflicts with an existing directory: " + destination)
            if os.path.lexists(destination) and not os.access(destination, os.W_OK):
                fail(73, "output file is read-only: " + destination)
        else:
            fail(73, "generator produced an unsupported entry: " + destination)

    def publish_fail(message):
        cleanup.keep(stage)
        fail(73, "%s; unpublished output kept in %s" % (message, stage))

    for entry in entries:
        relative = os.path.relpath(entry, stage)
        destination = os.path.join(output, relative)
        bad = symlink_in_path(output, relative)
        if bad:
            publish_fail("output path became a symlink: " + bad)
        if os.path.isdir(entry):
            if not os.path.isdir(destination):
                try:
                    os.mkdir(destination)
                except OSError:
                    publish_fail("cannot create output directory: " + destination)
        else:
            try:
                os.replace(entry, destination)
            except OSError:
                publish_fail("cannot publish output file: " + destination)


# ---------------------------------------------------------------------------
# Paths relative to the current directory (capnp and generate modes).


def compiler_operation(args):
    for index, arg in enumerate(args):
        if arg == "--":
            break
        if not arg.startswith("-"):
            if arg in COMPILER_OPERATIONS:
                return index, arg
            break
    return None, None


def compiler_path_arguments(args):
    """Locate filenames without interpreting constant expressions or format names."""
    operation_index, operation = compiler_operation(args)
    if operation_index is None:
        return []
    paths = []
    position = 0
    options = True
    index = operation_index + 1
    while index < len(args):
        arg = args[index]
        if options and arg == "--":
            options = False
        elif options and arg in ("-I", "--import-path", "--src-prefix"):
            index += 1
            if index < len(args):
                paths.append((index, "", True))
        elif options and arg.startswith(("--import-path=", "--src-prefix=")):
            paths.append((index, arg.split("=", 1)[0] + "=", True))
        elif options and arg.startswith("-I"):
            paths.append((index, "-I", True))
        elif options and arg in ("-o", "--output", "--segment-size"):
            index += 1
        elif options and arg.startswith("-"):
            pass
        else:
            if (operation == "compile" or
                    operation in ("encode", "decode", "eval") and position == 0 or
                    operation == "convert" and position == 1):
                paths.append((index, "", False))
            position += 1
        index += 1
    return paths


def is_within(path, root, native):
    try:
        return native.normcase(native.commonpath([path, root])) == native.normcase(root)
    except ValueError:
        return False


def translate_paths(args, cwd, include=None, windows=None):
    """Return the guest root, the guest cwd, and the translated arguments.

    Every filename, -I path, and --src-prefix shares one translation: the
    deepest common directory of the current directory and every path argument
    becomes guest /. KJ opens files through its one root directory, so a second
    preopen cannot supply another tree. A compile without a source prefix that
    covers the current directory gains --src-prefix for it, so requested file
    names stay relative to the caller. `include`, when given, is added after
    the caller's options as --no-standard-import -I<include>.
    """
    import ntpath
    import posixpath

    windows = WINDOWS if windows is None else windows
    native = ntpath if windows else posixpath
    cwd = native.normpath(str(cwd))
    args = list(args)
    if include is not None:
        end = args.index("--") if "--" in args else len(args)
        args[end:end] = ["--no-standard-import", "-I" + include]
    roots = [cwd]
    paths = []
    for index, prefix, directory in compiler_path_arguments(args):
        value = args[index][len(prefix):]
        if not value:
            continue  # Keep the compiler's own diagnostic for an empty option.
        if windows and ntpath.splitdrive(value)[0] and not ntpath.isabs(value):
            fail(64, "drive-relative paths are ambiguous; use an absolute path: " + value)
        absolute = native.normpath(native.join(cwd, value))
        roots.append(absolute if directory else native.dirname(absolute))
        paths.append((index, prefix, absolute))
    try:
        root = native.commonpath(roots)
    except ValueError:
        fail(64, "schema and include paths must be on the current directory's volume; copy those inputs "
                 "there first")
    if "::" in root:
        fail(64, "filesystem path cannot contain ::: " + root)

    def guest(path):
        relative = native.relpath(path, root)
        return "/" if relative == "." else "/" + relative.replace("\\", "/")

    result = list(args)
    for index, prefix, absolute in paths:
        result[index] = prefix + guest(absolute)
    if compiler_operation(args)[1] == "compile" and paths:
        prefixes = [absolute for index, prefix, absolute in paths
                    if prefix == "--src-prefix=" or (prefix == "" and index > 0 and args[index - 1] == "--src-prefix")]
        if not any(is_within(cwd, prefix, native) for prefix in prefixes):
            end = result.index("--") if "--" in result else len(result)
            result.insert(end, "--src-prefix=" + guest(cwd))
    return root, guest(cwd), result


def needs_standard_import(args):
    end = args.index("--") if "--" in args else len(args)
    options = args[:end]
    return (compiler_operation(args)[1] in INCLUDE_OPERATIONS and
            "--no-standard-import" not in options and
            not any(arg in ("--version", "--help") for arg in options))


def run_capnp(cleanup, package, runtime, settings, args, stdout=None):
    """Run the compiler on caller-relative paths; return its exit status."""
    cwd = os.path.realpath(os.getcwd())
    include = None
    if needs_standard_import(args):
        include = os.path.join(package, "include")
        root, _guest_cwd, _translated = translate_paths(args, cwd)
        if not is_within(include, root, os.path):
            # Stage the small bundled schema tree under the current directory,
            # so it shares the caller's root instead of widening it.
            staged = make_stage(cleanup, [cwd], ".capnp-wasm-include.")
            include = os.path.join(staged, "include")
            try:
                shutil.copytree(os.path.join(package, "include"), include)
            except (OSError, shutil.Error):
                fail(73, "cannot stage the bundled schemas in " + staged)
    root, _guest_cwd, translated = translate_paths(args, cwd, include)
    module = os.path.join(package, "wasm", "capnp.wasm")
    return run_guest(runtime, settings, module, root, "capnp", translated, stdout=stdout)


# ---------------------------------------------------------------------------
# Modes.


def parse_options(mode, args, allowed, repeatable=()):
    options = {}
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "--":
            return options, args[index + 1:]
        name, separator, value = arg.partition("=")
        if separator and name in repeatable:
            options.setdefault(name, []).append(value)
            index += 1
            continue
        if arg not in allowed or index + 1 >= len(args):
            fail(64, USAGE)
        if arg in repeatable:
            options.setdefault(arg, []).append(args[index + 1])
        else:
            if arg in options:
                fail(64, USAGE)
            options[arg] = args[index + 1]
        index += 2
    fail(64, "missing -- before command arguments")


def main(argv):
    root = package_root()
    if not argv:
        fail(64, USAGE)
    mode, args = argv[0], argv[1:]
    if mode in ("--help", "-h", "help"):
        sys.stdout.write(HELP + "\n")
        return 0
    if mode in ("--version", "version"):
        sys.stdout.write("capnp-wasm %s\n" % package_version(root))
        try:
            with open(os.path.join(root, "runtime", "wasmtime-version"), "r", encoding="utf-8") as stream:
                sys.stdout.write("wasmtime %s\n" % stream.read().strip())
        except OSError:
            pass
        return 0
    if mode == "verify":
        expect = None
        if args:
            if len(args) != 2 or args[0] != "--expect-manifest-sha256" or not re.fullmatch(
                    r"[0-9a-fA-F]{64}", args[1]):
                fail(64, USAGE)
            expect = args[1].lower()
        expect = expect or expected_manifest_digest()
        manifest, digest = verify_package(root, expect)
        sys.stdout.write("verified %s %s: %d files, manifest.json sha256 %s\n"
                         % (manifest.get("name"), manifest.get("version"), len(manifest["files"]), digest))
        return 0
    if mode not in ("compiler", "generator", "capnp", "generate"):
        fail(64, USAGE)

    if mode == "compiler":
        options, rest = parse_options(mode, args, ("--workspace",))
        if not rest:
            fail(64, "missing compiler arguments")
    elif mode == "generator":
        options, rest = parse_options(mode, args, ("--module", "--output"))
        if "--module" not in options or "--output" not in options:
            fail(64, USAGE)
    elif mode == "capnp":
        options, rest = parse_options(mode, args, ())
        if not rest:
            fail(64, "missing compiler arguments")
    else:
        options, rest = parse_options(mode, args, ("--module", "--plugin", "--output", "--plugin-arg"),
                                      repeatable=("--plugin-arg",))
        if ("--module" in options) == ("--plugin" in options) or "--output" not in options:
            fail(64, USAGE)
        if not rest:
            fail(64, "missing schema arguments")
        end = rest.index("--") if "--" in rest else len(rest)
        if rest[:1] == ["compile"] or any(arg in ("-o", "--output") or arg.startswith(("-o", "--output="))
                                          for arg in rest[:end]):
            fail(64, "generate supplies compile -o-; give only the schema arguments")

    expect = expected_manifest_digest()
    settings = read_settings(root)
    verify_package(root, expect)
    runtime = resolve_runtime(settings)
    cleanup = Cleanup()
    try:
        if mode == "compiler":
            guest_root = stage_workspace(cleanup, settings, options.get("--workspace"))
            module = os.path.join(root, "wasm", "capnp.wasm")
            return run_guest(runtime, settings, module, guest_root, "capnp", rest)
        if mode == "generator":
            module, argv0 = check_module(options["--module"])
            output = resolve_root("output directory", options["--output"])
            if not os.access(output, os.W_OK):
                fail(73, "output directory is not writable: " + output)
            parent = os.path.dirname(output) or os.sep
            stage = make_stage(cleanup, [parent, output], ".capnp-wasm.")
            warn_zig_environment()
            status = run_guest(runtime, settings, module, stage, argv0, rest)
            if status == 0:
                publish_output(cleanup, stage, output)
            return status
        if mode == "capnp":
            return run_capnp(cleanup, root, runtime, settings, rest)
        return generate(cleanup, root, runtime, settings, options, rest)
    finally:
        cleanup.run()


def generate(cleanup, package, runtime, settings, options, schema_args):
    plugin_args = options.get("--plugin-arg", [])
    if "--module" in options:
        module, argv0 = check_module(options["--module"], relative_allowed=True)
        warn_zig_environment()
    else:
        plugin = os.path.abspath(options["--plugin"])
        if WINDOWS and not os.path.exists(plugin) and not plugin.lower().endswith(".exe"):
            plugin += ".exe"
        if not (os.path.isfile(plugin) and os.access(plugin, os.X_OK)):
            fail(66, "native generator is not an executable file: " + plugin)
    output = os.path.abspath(options["--output"])
    if "::" in output:
        fail(64, "output directory cannot contain ::: " + output)
    try:
        os.makedirs(output, exist_ok=True)
    except OSError:
        fail(73, "cannot create the output directory: " + output)
    output = resolve_root("output directory", output)
    if not os.access(output, os.W_OK):
        fail(73, "output directory is not writable: " + output)
    # Spool the request: no pipe can deadlock while the compiler reports
    # errors, and the generator never runs after a failed compile.
    with tempfile.TemporaryFile() as request:
        status = run_capnp(cleanup, package, runtime, settings, ["compile", "-o-"] + list(schema_args),
                           stdout=request)
        if status != 0:
            return status
        request.seek(0)
        parent = os.path.dirname(output) or os.sep
        stage = make_stage(cleanup, [parent, output], ".capnp-wasm.")
        if "--module" in options:
            status = run_guest(runtime, settings, module, stage, argv0, plugin_args, stdin=request)
        else:
            status = run_child([plugin] + list(plugin_args), stage, stdin=request, start_failure=66)
        if status == 0:
            publish_output(cleanup, stage, output)
        return status


def cli(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        status = main(argv)
    except Failure as failure:
        sys.stderr.write("capnp-wasm: %s\n" % failure.message)
        status = failure.code
    except Stopped as stopped:
        sys.stderr.flush()
        if WINDOWS:
            return 128 + int(stopped.number)
        signal.signal(stopped.number, signal.SIG_DFL)
        os.kill(os.getpid(), stopped.number)
        return 128 + int(stopped.number)
    except (OSError, subprocess.SubprocessError) as error:
        sys.stderr.write("capnp-wasm: %s\n" % error)
        status = 1
    return status


if __name__ == "__main__":
    sys.exit(cli())
