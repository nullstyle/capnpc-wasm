"""Tests for bin/capnp-wasm.py that run on Linux, macOS, and Windows.

tests/package/launcher.ts checks the shared launcher contract on Linux and
macOS for both launchers. This file covers what only the Python launcher has
(package verification, the capnp and generate modes, and path translation,
including Windows paths) and is the Windows acceptance test for the release
workflow's archives. It uses the standard library only.

    CAPNP_WASM_TEST_PACKAGE=/abs/package \\
    CAPNP_WASM_TEST_MODULES=/abs/dir/with/capnpc-zig.wasm \\
    python3 -m unittest tests/package/portable_launcher_test.py

Without CAPNP_WASM_TEST_PACKAGE only the path translation tests run, against
bin/capnp-wasm.py in this checkout. Wasmtime must be on PATH (or named by
CAPNP_WASM_WASMTIME) for the end-to-end tests.
"""

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

# Loading the launcher must not write a __pycache__ into the package, which
# would then fail its own inventory check.
sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
REPOSITORY = os.path.dirname(os.path.dirname(HERE))
PACKAGE = os.environ.get("CAPNP_WASM_TEST_PACKAGE")
MODULES = os.environ.get("CAPNP_WASM_TEST_MODULES")
WINDOWS = os.name == "nt"


def load_launcher():
    path = os.path.join(PACKAGE or REPOSITORY, "bin", "capnp-wasm.py")
    spec = importlib.util.spec_from_file_location("capnp_wasm_launcher", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


launcher = load_launcher()

SCHEMA = b"""@0xb1c2d3e4f5a6b7c8;
struct Checkpoint {
  timeline @0 :UInt64;
  pos @1 :UInt32;
  prefix @2 :UInt64;
  state @3 :Data;
  status @4 :Status;
  struct Status { kind @0 :UInt8; message @1 :Text; }
}
"""

IMPORTING = b"""@0xe1e2f3a4b5c6d7e9;
using Cxx = import "/capnp/c++.capnp";
using import "b.capnp".B;
$Cxx.namespace("probe");
struct A { b @0 :B; n @1 :UInt32; }
"""

IMPORTED = b"""@0xd1e2f3a4b5c6d7e8;
struct B { value @0 :Text; }
"""

# (module (func (export "_start") (loop (br 0))))
LOOP_MODULE = bytes.fromhex(
    "0061736d01000000" "010401600000" "03020100" "070a01065f73746172740000"
    "0a090107000340" "0c000b0b")


class TranslatePaths(unittest.TestCase):
    """The capnp mode's path translation, as capnp-zig's driver tested it."""

    def translate(self, args, cwd, windows, include=None):
        return launcher.translate_paths(args, cwd, include, windows=windows)

    def test_posix_relative_schema_gains_a_source_prefix(self):
        root, guest_cwd, args = self.translate(
            ["compile", "-o-", "schema/checkpoint.capnp"], "/work/project", False)
        self.assertEqual(root, "/work/project")
        self.assertEqual(guest_cwd, "/")
        self.assertEqual(args, ["compile", "-o-", "/schema/checkpoint.capnp", "--src-prefix=/"])

    def test_posix_parent_paths_widen_the_root(self):
        root, guest_cwd, args = self.translate(
            ["compile", "-o-", "-I../shared", "../schema/a.capnp"], "/work/project", False)
        self.assertEqual(root, "/work")
        self.assertEqual(guest_cwd, "/project")
        self.assertEqual(args, ["compile", "-o-", "-I/shared", "/schema/a.capnp", "--src-prefix=/project"])

    def test_explicit_ancestor_prefix_is_kept_alone(self):
        _root, _cwd, args = self.translate(
            ["compile", "-o-", "--src-prefix=.", "schema/a.capnp"], "/work/project", False)
        self.assertEqual(args, ["compile", "-o-", "--src-prefix=/", "/schema/a.capnp"])

    def test_descendant_prefix_still_gains_the_cwd_prefix(self):
        _root, _cwd, args = self.translate(
            ["compile", "-o-", "--src-prefix", "schema", "schema/a.capnp"], "/work/project", False)
        self.assertEqual(args, ["compile", "-o-", "--src-prefix", "/schema", "/schema/a.capnp",
                                "--src-prefix=/"])

    def test_include_goes_after_the_callers_options(self):
        _root, _cwd, args = self.translate(
            ["compile", "-o-", "-Isrc", "a.capnp", "--", "b.capnp"], "/p", False, include="/p/inc")
        self.assertEqual(args, ["compile", "-o-", "-I/src", "/a.capnp", "--no-standard-import", "-I/inc",
                                "--src-prefix=/", "--", "/b.capnp"])
        self.assertLess(args.index("-I/src"), args.index("-I/inc"))
        self.assertLess(args.index("-I/inc"), args.index("--"))

    def test_encode_translates_only_the_schema_file(self):
        _root, _cwd, args = self.translate(
            ["encode", "schema/a.capnp", "Type"], "/p", False)
        self.assertEqual(args, ["encode", "/schema/a.capnp", "Type"])

    def test_convert_translates_its_schema_position(self):
        _root, _cwd, args = self.translate(
            ["convert", "text:binary", "schema/a.capnp", "Type"], "/p", False)
        self.assertEqual(args, ["convert", "text:binary", "/schema/a.capnp", "Type"])

    def test_windows_paths_use_forward_slashes_in_the_guest(self):
        root, guest_cwd, args = self.translate(
            ["compile", "-o-", "schema\\checkpoint.capnp"], "C:\\work\\project", True)
        self.assertEqual(root, "C:\\work\\project")
        self.assertEqual(guest_cwd, "/")
        self.assertEqual(args, ["compile", "-o-", "/schema/checkpoint.capnp", "--src-prefix=/"])

    def test_windows_drive_relative_path_is_refused(self):
        with self.assertRaises(launcher.Failure) as caught:
            self.translate(["compile", "-o-", "D:schema.capnp"], "C:\\work", True)
        self.assertEqual(caught.exception.code, 64)

    def test_windows_second_volume_is_refused(self):
        with self.assertRaises(launcher.Failure) as caught:
            self.translate(["compile", "-o-", "D:\\schema.capnp"], "C:\\work", True)
        self.assertEqual(caught.exception.code, 64)

    def test_windows_absolute_path_on_the_same_volume(self):
        root, _cwd, args = self.translate(
            ["compile", "-o-", "C:\\shared\\a.capnp"], "C:\\work\\project", True)
        self.assertEqual(root, "C:\\")
        self.assertEqual(args[:3], ["compile", "-o-", "/shared/a.capnp"])

    def test_version_takes_no_paths(self):
        self.assertEqual(launcher.compiler_path_arguments(["--version"]), [])
        self.assertFalse(launcher.needs_standard_import(["compile", "--version"]))
        self.assertFalse(launcher.needs_standard_import(["compile", "--no-standard-import", "a.capnp"]))
        self.assertTrue(launcher.needs_standard_import(["compile", "-o-", "a.capnp"]))


@unittest.skipUnless(PACKAGE, "set CAPNP_WASM_TEST_PACKAGE to an extracted package")
class EndToEnd(unittest.TestCase):

    def setUp(self):
        self.scratch = tempfile.mkdtemp(prefix="capnp wasm launcher ")
        self.addCleanup(launcher.remove_tree, self.scratch)
        self.script = os.path.join(PACKAGE, "bin", "capnp-wasm.py")

    def run_launcher(self, *args, cwd=None, env=None, stdin=None):
        environment = dict(os.environ)
        environment.update(env or {})
        return subprocess.run([sys.executable, self.script] + list(args), cwd=cwd or self.scratch,
                              env=environment, input=stdin, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=300)

    def write(self, relative, data):
        path = os.path.join(self.scratch, *relative.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as stream:
            stream.write(data)
        return path

    def assertStatus(self, result, code):
        self.assertEqual(result.returncode, code, result.stderr.decode("utf-8", "replace"))

    def test_verify_and_version(self):
        result = self.run_launcher("verify")
        self.assertStatus(result, 0)
        with open(os.path.join(PACKAGE, "manifest.json"), "rb") as stream:
            digest = hashlib.sha256(stream.read()).hexdigest()
        self.assertIn(digest, result.stdout.decode())
        self.assertStatus(self.run_launcher("verify", "--expect-manifest-sha256", digest), 0)
        self.assertStatus(self.run_launcher("verify", "--expect-manifest-sha256", "0" * 64), 74)
        version = self.run_launcher("--version")
        self.assertStatus(version, 0)
        with open(os.path.join(PACKAGE, "package.json"), "rb") as stream:
            self.assertIn("capnp-wasm %s" % json.load(stream)["version"], version.stdout.decode())

    def test_tampered_copy_fails_verification(self):
        copy = os.path.join(self.scratch, "package copy")
        shutil.copytree(PACKAGE, copy)
        with open(os.path.join(copy, "include", "capnp", "c++.capnp"), "ab") as stream:
            stream.write(b"\n")
        result = subprocess.run([sys.executable, os.path.join(copy, "bin", "capnp-wasm.py"), "compiler", "--",
                                 "--version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        self.assertStatus(result, 74)
        self.assertIn(b"package integrity mismatch", result.stderr)

    def test_capnp_mode_matches_the_workspace_flow(self):
        self.write("project/schema/checkpoint.capnp", SCHEMA)
        project = os.path.join(self.scratch, "project")
        relative = self.run_launcher("capnp", "--", "compile", "-o-", "--src-prefix=schema",
                                     os.path.join("schema", "checkpoint.capnp"), cwd=project)
        self.assertStatus(relative, 0)
        workspace = os.path.join(self.scratch, "workspace")
        os.makedirs(workspace)
        shutil.copytree(os.path.join(PACKAGE, "include"), os.path.join(workspace, "include"))
        shutil.copyfile(os.path.join(project, "schema", "checkpoint.capnp"),
                        os.path.join(workspace, "checkpoint.capnp"))
        staged = self.run_launcher("compiler", "--workspace", workspace, "--", "compile",
                                   "--no-standard-import", "-I/include", "--src-prefix=/", "-o-",
                                   "/checkpoint.capnp")
        self.assertStatus(staged, 0)
        self.assertEqual(relative.stdout, staged.stdout)
        self.assertGreater(len(relative.stdout), 0)
        self.assertEqual(sorted(os.listdir(project)), ["schema"], "staged schemas were left behind")

    def test_capnp_mode_resolves_standard_and_sibling_imports(self):
        self.write("project/tests/schemas/a.capnp", IMPORTING)
        self.write("project/tests/schemas/b.capnp", IMPORTED)
        project = os.path.join(self.scratch, "project")
        result = self.run_launcher("capnp", "--", "compile", "-o-", "tests/schemas/a.capnp", cwd=project)
        self.assertStatus(result, 0)
        self.assertIn(b"tests/schemas/a.capnp", result.stdout)
        missing = self.run_launcher("capnp", "--", "compile", "--no-standard-import", "-o-",
                                    "tests/schemas/a.capnp", cwd=project)
        self.assertStatus(missing, 1)

    @unittest.skipUnless(MODULES, "set CAPNP_WASM_TEST_MODULES to a directory with capnpc-zig.wasm")
    def test_generate_with_a_wasm_generator_matches_generator_mode(self):
        self.write("project/schema/checkpoint.capnp", SCHEMA)
        project = os.path.join(self.scratch, "project")
        module = os.path.join(MODULES, "capnpc-zig.wasm")
        generated = self.run_launcher("generate", "--module", module, "--output", "gen", "--",
                                      "--src-prefix=schema", "schema/checkpoint.capnp", cwd=project)
        self.assertStatus(generated, 0)
        with open(os.path.join(project, "gen", "checkpoint.zig"), "rb") as stream:
            first = stream.read()
        self.assertIn(b"pub const Checkpoint = struct", first)
        request = self.run_launcher("capnp", "--", "compile", "-o-", "--src-prefix=schema",
                                    "schema/checkpoint.capnp", cwd=project)
        self.assertStatus(request, 0)
        output = os.path.join(self.scratch, "generator output")
        os.makedirs(output)
        direct = self.run_launcher("generator", "--module", module, "--output", output, "--",
                                   stdin=request.stdout)
        self.assertStatus(direct, 0)
        with open(os.path.join(output, "checkpoint.zig"), "rb") as stream:
            self.assertEqual(stream.read(), first)
        compact = self.run_launcher("generate", "--module", module, "--output", "compact",
                                    "--plugin-arg=--api-profile=compact", "--", "--src-prefix=schema",
                                    "schema/checkpoint.capnp", cwd=project)
        self.assertStatus(compact, 0)
        with open(os.path.join(project, "compact", "checkpoint.zig"), "rb") as stream:
            self.assertNotEqual(stream.read(), first)
        failed = self.run_launcher("generate", "--module", module, "--output", "never", "--",
                                   "schema/missing.capnp", cwd=project)
        self.assertStatus(failed, 1)
        self.assertEqual(os.listdir(os.path.join(project, "never")), [])

    def test_usage_and_input_errors(self):
        self.assertStatus(self.run_launcher(), 64)
        self.assertStatus(self.run_launcher("build"), 64)
        self.assertStatus(self.run_launcher("capnp"), 64)
        self.assertStatus(self.run_launcher("generate", "--output", "x", "--", "a.capnp"), 64)
        self.assertStatus(self.run_launcher("generate", "--module", "m.wasm", "--output", "x", "--",
                                            "compile", "a.capnp"), 64)
        self.assertStatus(self.run_launcher("compiler", "--workspace", "relative", "--", "--version"), 64)
        not_wasm = self.write("not a module.wasm", b"not wasm")
        output = os.path.join(self.scratch, "out")
        os.makedirs(output)
        self.assertStatus(self.run_launcher("generator", "--module", not_wasm, "--output", output, "--"), 65)
        self.assertStatus(self.run_launcher("generator", "--module", not_wasm + ".missing", "--output",
                                            output, "--"), 66)
        self.assertStatus(self.run_launcher("compiler", "--", "--version",
                                            env={"CAPNP_WASM_TIMEOUT": "1.5"}), 78)
        self.assertStatus(self.run_launcher("compiler", "--", "--version",
                                            env={"CAPNP_WASM_WASMTIME": os.path.join(self.scratch, "none")}), 69)

    def test_guest_status_and_trap(self):
        loop = self.write("modules/loop.wasm", LOOP_MODULE)
        output = os.path.join(self.scratch, "out")
        os.makedirs(output)
        trapped = self.run_launcher("generator", "--module", loop, "--output", output, "--",
                                    env={"CAPNP_WASM_TIMEOUT": "1"})
        self.assertStatus(trapped, 134)
        self.assertIn(b"wasm trap", trapped.stderr)
        self.assertEqual(os.listdir(output), [])
        bad = self.run_launcher("compiler", "--", "compile", "--bogus")
        self.assertStatus(bad, 1)
        self.assertIn(b"capnp compile", bad.stderr)

    def test_compiler_workspace_stays_unchanged(self):
        self.write("workspace/checkpoint.capnp", SCHEMA)
        workspace = os.path.join(self.scratch, "workspace")
        before = sorted(os.listdir(workspace))
        result = self.run_launcher("compiler", "--workspace", workspace, "--", "compile",
                                   "--no-standard-import", "-o-", "/checkpoint.capnp")
        self.assertStatus(result, 0)
        self.assertEqual(sorted(os.listdir(workspace)), before)
        with open(os.path.join(workspace, "checkpoint.capnp"), "rb") as stream:
            self.assertEqual(stream.read(), SCHEMA)


if __name__ == "__main__":
    unittest.main()
