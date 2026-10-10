#!/usr/bin/env -S deno run --allow-all --no-config
// capnp-wasm.ts: run the packaged Cap'n Proto compiler and WASI code generators
// under Wasmtime on Linux, macOS, and Windows. It needs Deno 2.4.5 or newer
// and imports nothing, so it runs offline from the verified package:
//
//   deno run --allow-all --no-config package/bin/capnp-wasm.ts MODE ...
//
// The compiler and generator modes are the launcher contract: one explicit
// filesystem capability, bounded guests, read-only inputs, transactional
// generator output, and fixed exit statuses. Every run first verifies the
// package against its manifest.json. The capnp and generate modes take paths
// relative to the current directory, like a native capnp; they and their path
// translation are ported from capnp-zig's tools/capnp_tool.py (the same
// author), which capnp-zig's CI ran on Linux, macOS, and Windows.

const WINDOWS = Deno.build.os === "windows";
// Deno 2.4.5 implemented Deno.chmod on Windows, which write-protects the
// workspace copy there.
const MINIMUM_DENO = [2, 4, 5] as const;

const USAGE =
  `usage: capnp-wasm.ts compiler [--workspace ABS_DIR] -- CAPNP_ARGS...
       capnp-wasm.ts generator --module ABS_WASM --output ABS_DIR -- GENERATOR_ARGS...
       capnp-wasm.ts capnp -- CAPNP_ARGS...
       capnp-wasm.ts generate (--module WASM | --plugin EXE) --output DIR
                     [--plugin-arg ARG]... -- SCHEMA_ARGS...
       capnp-wasm.ts verify [--expect-manifest-sha256 HEX]
       capnp-wasm.ts --help | --version`;

const HELP = `${USAGE}

Run it with Deno ${MINIMUM_DENO.join(".")} or newer:
  deno run --allow-all --no-config package/bin/capnp-wasm.ts MODE ...

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
  78       Wasmtime version rejected, packaged runtime version missing, an
           environment override is invalid, or Deno is too old or lacks a
           permission
  134      Wasmtime trap: timeout, stack exhaustion, or a guest fault
  1        Wasmtime could not load or instantiate the module
  128+N    the launcher was stopped by signal N
Other failures of the launcher itself exit with status 1.`;

const MAX_WASM_STACK = 8388608;
const MAX_BACKTRACE = 16;
const MAX_ENTRIES = 65536;
const COMPILER_OPERATIONS = [
  "compile",
  "encode",
  "decode",
  "eval",
  "convert",
  "id",
];
const INCLUDE_OPERATIONS = ["compile", "encode", "decode", "eval", "convert"];

/** A launcher failure: an exit status and a message. */
export class Failure extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

function fail(code: number, message: string): never {
  throw new Failure(code, message);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const encoder = new TextEncoder();

function writeAll(
  stream: { writeSync(data: Uint8Array): number },
  data: Uint8Array,
) {
  for (let offset = 0; offset < data.length;) {
    offset += stream.writeSync(data.subarray(offset));
  }
}

function say(message: string) {
  writeAll(Deno.stderr, encoder.encode(`capnp-wasm: ${message}\n`));
}

function warn(message: string) {
  say(`warning: ${message}`);
}

// ---------------------------------------------------------------------------
// Paths. Both flavors are always available, so path translation can be tested
// for Windows on any host.

interface ParsedPath {
  /** "C:" or "\\server\share" on Windows, empty otherwise. */
  drive: string;
  rooted: boolean;
  parts: string[];
}

/** Strips Windows' \\?\ prefix, which realPath may return. */
function stripVerbatim(path: string): string {
  if (/^\\\\\?\\UNC\\/i.test(path)) return `\\\\${path.slice(8)}`;
  if (/^\\\\\?\\[A-Za-z]:/.test(path)) return path.slice(4);
  return path;
}

function splitDrive(path: string, windows: boolean): [string, string] {
  if (!windows) return ["", path];
  const value = stripVerbatim(path).replaceAll("/", "\\");
  const unc = /^\\\\[^\\]+\\[^\\]+/.exec(value);
  if (unc) return [unc[0], value.slice(unc[0].length)];
  if (/^[A-Za-z]:/.test(value)) return [value.slice(0, 2), value.slice(2)];
  return ["", value];
}

export function parsePath(path: string, windows = WINDOWS): ParsedPath {
  const [drive, rest] = splitDrive(path, windows);
  const rooted = windows
    ? drive.startsWith("\\\\") || rest.startsWith("\\")
    : rest.startsWith("/");
  const parts: string[] = [];
  for (const part of rest.split(windows ? "\\" : "/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!rooted) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  return { drive, rooted, parts };
}

function formatPath(parsed: ParsedPath, windows = WINDOWS): string {
  const separator = windows ? "\\" : "/";
  const root = parsed.drive + (parsed.rooted ? separator : "");
  return root + parsed.parts.join(separator) || ".";
}

function samePart(a: string, b: string, windows: boolean): boolean {
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function isAbsolute(path: string, windows = WINDOWS): boolean {
  const { drive, rooted } = parsePath(path, windows);
  return rooted && (!windows || drive !== "");
}

export function joinPath(
  base: string,
  path: string,
  windows = WINDOWS,
): string {
  const separator = windows ? "\\" : "/";
  if (!windows) return path.startsWith("/") ? path : `${base}/${path}`;
  const [drive, rest] = splitDrive(path, true);
  if (drive !== "") {
    if (isAbsolute(path, true)) return path;
    if (!samePart(drive, splitDrive(base, true)[0], true)) return path;
    return `${base}${separator}${rest}`;
  }
  if (rest.startsWith("\\")) return splitDrive(base, true)[0] + rest;
  return `${base}${separator}${rest}`;
}

export function normalizePath(path: string, windows = WINDOWS): string {
  return formatPath(parsePath(path, windows), windows);
}

function join(base: string, ...names: string[]): string {
  return names.reduce((path, name) => joinPath(path, name), base);
}

function dirname(path: string): string {
  const parsed = parsePath(path);
  return formatPath({ ...parsed, parts: parsed.parts.slice(0, -1) });
}

function basename(path: string): string {
  return parsePath(path).parts.at(-1) ?? "";
}

/** The deepest directory holding every path, or undefined across volumes. */
export function commonPath(
  paths: string[],
  windows = WINDOWS,
): string | undefined {
  const parsed = paths.map((path) => parsePath(path, windows));
  const first = parsed[0];
  let length = first.parts.length;
  for (const other of parsed) {
    if (
      !samePart(other.drive, first.drive, windows) ||
      other.rooted !== first.rooted
    ) {
      return undefined;
    }
    let shared = 0;
    while (
      shared < length && shared < other.parts.length &&
      samePart(other.parts[shared], first.parts[shared], windows)
    ) shared++;
    length = shared;
  }
  return formatPath({ ...first, parts: first.parts.slice(0, length) }, windows);
}

export function isWithin(
  path: string,
  root: string,
  windows = WINDOWS,
): boolean {
  const inner = parsePath(path, windows);
  const outer = parsePath(root, windows);
  return samePart(inner.drive, outer.drive, windows) &&
    inner.rooted === outer.rooted && outer.parts.length <= inner.parts.length &&
    outer.parts.every((part, index) =>
      samePart(part, inner.parts[index], windows)
    );
}

/** The guest path of a host path inside root, which is guest /. */
function guestPath(path: string, root: string, windows: boolean): string {
  const parts = parsePath(path, windows).parts.slice(
    parsePath(root, windows).parts.length,
  );
  return `/${parts.join("/")}`;
}

function realPath(path: string): string {
  return normalizePath(Deno.realPathSync(path));
}

function lstat(path: string): Deno.FileInfo | undefined {
  try {
    return Deno.lstatSync(path);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Stopping: SIGINT, SIGTERM, and SIGHUP (SIGINT and SIGBREAK on Windows) are
// forwarded to a running guest as SIGTERM; the launcher then removes its
// staging directories and stops itself with the same signal.

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
  SIGBREAK: 21,
};

class Stopped extends Error {
  constructor(readonly signal: Deno.Signal) {
    super(signal);
  }
}

const stopping: { signal?: Deno.Signal; child?: Deno.ChildProcess } = {};

function checkStop() {
  if (stopping.signal) throw new Stopped(stopping.signal);
}

function installStopListeners(): () => void {
  const installed: [Deno.Signal, () => void][] = [];
  const signals: Deno.Signal[] = WINDOWS
    ? ["SIGINT", "SIGBREAK"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) {
    const listener = () => {
      stopping.signal ??= signal;
      try {
        stopping.child?.kill("SIGTERM");
      } catch {
        // The guest has already exited.
      }
    };
    try {
      Deno.addSignalListener(signal, listener);
      installed.push([signal, listener]);
    } catch {
      // This platform cannot deliver the signal.
    }
  }
  return () => {
    for (const [signal, listener] of installed) {
      try {
        Deno.removeSignalListener(signal, listener);
      } catch {
        // Already removed.
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Package location and verification: manifest.json lists every other file with
// its length and sha256, as scripts/verify-release.ts checks it.

function packageRoot(): string {
  const self = import.meta.filename;
  if (self === undefined) {
    fail(70, `cannot locate the package root from ${import.meta.url}`);
  }
  try {
    return dirname(dirname(realPath(self)));
  } catch (error) {
    fail(70, `cannot resolve the launcher location: ${describe(error)}`);
  }
}

function packageVersion(root: string): string {
  try {
    const version =
      JSON.parse(Deno.readTextFileSync(join(root, "package.json"))).version;
    if (typeof version === "string" && version !== "") return version;
  } catch {
    // A missing or invalid package.json has no version.
  }
  return "unknown";
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(data)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

interface Entry {
  path: string;
  /** The names from the walked root down to this entry. */
  parts: string[];
  info: Deno.FileInfo;
}

/**
 * Every entry below root, parents before children, without following links.
 * A tolerant walk skips what it cannot read; it stops after `limit` entries.
 */
async function walk(
  root: string,
  tolerant: boolean,
  limit = Infinity,
): Promise<Entry[]> {
  const entries: Entry[] = [];
  const pending: [string, string[]][] = [[root, []]];
  while (pending.length > 0 && entries.length <= limit) {
    checkStop();
    const [directory, parts] = pending.pop()!;
    const names: string[] = [];
    try {
      for await (const entry of Deno.readDir(directory)) names.push(entry.name);
    } catch (error) {
      if (tolerant) continue;
      throw error;
    }
    const children: [string, string[]][] = [];
    for (const name of names.sort()) {
      const path = join(directory, name);
      let info: Deno.FileInfo;
      try {
        info = await Deno.lstat(path);
      } catch (error) {
        if (tolerant) continue;
        throw error;
      }
      entries.push({ path, parts: [...parts, name], info });
      if (info.isDirectory) children.push([path, [...parts, name]]);
      if (entries.length > limit) break;
    }
    pending.push(...children.reverse());
  }
  return entries.sort((a, b) => compareParts(a.parts, b.parts));
}

function compareParts(a: string[], b: string[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return a.length - b.length;
}

interface Manifest {
  name?: unknown;
  version?: unknown;
  files: { path: string; bytes: number; sha256: string }[];
}

/** Returns the manifest and its sha256, or fails with 74. */
async function verifyPackage(
  root: string,
  expect?: string,
): Promise<{ manifest: Manifest; digest: string }> {
  try {
    const raw = await Deno.readFile(join(root, "manifest.json"));
    const digest = await sha256(raw);
    if (expect !== undefined && digest !== expect) {
      throw new Error(
        `manifest.json digest ${digest} does not match the expected ${expect}`,
      );
    }
    const manifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(raw),
    );
    if (manifest?.format !== 1 || !Array.isArray(manifest.files)) {
      throw new Error("invalid release manifest");
    }
    const expected = new Set(["manifest.json"]);
    for (const entry of manifest.files) {
      const path = entry?.path;
      if (
        typeof path !== "string" || path.includes("\\") ||
        path.includes("\0") ||
        path.split("/").some((part: string) =>
          ["", ".", ".."].includes(part)
        ) ||
        expected.has(path)
      ) throw new Error("invalid or duplicate manifest path");
      if (
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
        typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)
      ) throw new Error(`invalid manifest digest: ${path}`);
      expected.add(path);
    }
    const actual: string[] = [];
    for (const entry of await walk(root, false)) {
      const name = entry.parts.join("/");
      if (entry.info.isSymlink) {
        throw new Error(`package symlink is forbidden: ${name}`);
      }
      if (entry.info.isFile) actual.push(name);
      else if (!entry.info.isDirectory) {
        throw new Error(`unsupported package entry: ${name}`);
      }
    }
    const unexpected = actual.filter((path) => !expected.has(path));
    const missing = [...expected].filter((path) => !actual.includes(path))
      .sort();
    if (unexpected.length > 0 || missing.length > 0) {
      throw new Error(`package files do not match the manifest inventory (${
        [
          ...unexpected.slice(0, 4).map((path) => `unexpected ${path}`),
          ...missing.slice(0, 4).map((path) => `missing ${path}`),
        ].join(", ")
      })`);
    }
    for (const entry of manifest.files) {
      checkStop();
      const data = await Deno.readFile(join(root, ...entry.path.split("/")));
      if (data.length !== entry.bytes || await sha256(data) !== entry.sha256) {
        throw new Error(`package integrity mismatch: ${entry.path}`);
      }
    }
    let metadata;
    try {
      metadata = JSON.parse(
        await Deno.readTextFile(join(root, "package.json")),
      );
    } catch {
      throw new Error("package.json is missing or invalid");
    }
    if (
      metadata?.name !== manifest.name || metadata?.version !== manifest.version
    ) {
      throw new Error("package identity does not match the manifest");
    }
    return { manifest, digest };
  } catch (error) {
    if (error instanceof Stopped) throw error;
    fail(74, `package verification failed: ${describe(error)}`);
  }
}

function expectedManifestDigest(): string | undefined {
  const value = (Deno.env.get("CAPNP_WASM_EXPECT_MANIFEST_SHA256") ?? "")
    .toLowerCase();
  if (value === "") return undefined;
  if (!/^[0-9a-f]{64}$/.test(value)) {
    fail(
      78,
      `CAPNP_WASM_EXPECT_MANIFEST_SHA256 must be a sha256 in hex: ${value}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Deno, the runtime requirement, and the environment overrides.

function checkDeno() {
  const version = Deno.version.deno.split(/[.+-]/).slice(0, 3).map(Number);
  const differs = MINIMUM_DENO.findIndex((part, index) =>
    version[index] !== part
  );
  if (differs >= 0 && !(version[differs] > MINIMUM_DENO[differs])) {
    fail(
      78,
      `Deno ${
        MINIMUM_DENO.join(".")
      } or newer is required; this is Deno ${Deno.version.deno}`,
    );
  }
  const missing = (["read", "write", "env", "run", "sys"] as const).filter((
    name,
  ) => Deno.permissions.querySync({ name }).state !== "granted");
  if (missing.length > 0) {
    fail(
      78,
      `run the launcher with deno run --allow-all --no-config (missing ${
        missing.map((name) => `--allow-${name}`).join(", ")
      })`,
    );
  }
}

interface Settings {
  expectedVersion: string;
  timeout: string;
  maxMemory: string;
  maxWorkspace: number;
  acceptVersion: string;
}

function readSettings(root: string): Settings {
  let expectedVersion: string;
  try {
    expectedVersion = Deno.readTextFileSync(
      join(root, "runtime", "wasmtime-version"),
    ).trim();
  } catch {
    fail(78, "missing packaged runtime version");
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(expectedVersion)) {
    fail(78, "invalid packaged runtime version");
  }
  const timeout = Deno.env.get("CAPNP_WASM_TIMEOUT") ?? "300";
  if (!/^(0|[1-9][0-9]{0,5})$/.test(timeout)) {
    fail(
      78,
      `CAPNP_WASM_TIMEOUT must be a whole number of seconds (0 disables): ${timeout}`,
    );
  }
  const maxMemory = Deno.env.get("CAPNP_WASM_MAX_MEMORY") ?? "268435456";
  if (
    !/^[1-9][0-9]{0,9}$/.test(maxMemory) || Number(maxMemory) < 16777216 ||
    Number(maxMemory) > 4294967296
  ) {
    fail(
      78,
      `CAPNP_WASM_MAX_MEMORY must be a byte count from 16777216 to 4294967296: ${maxMemory}`,
    );
  }
  const workspace = Deno.env.get("CAPNP_WASM_MAX_WORKSPACE") ?? "268435456";
  if (!/^[1-9][0-9]{0,11}$/.test(workspace)) {
    fail(
      78,
      `CAPNP_WASM_MAX_WORKSPACE must be a positive byte count: ${workspace}`,
    );
  }
  const acceptVersion = Deno.env.get("CAPNP_WASM_WASMTIME_ACCEPT_VERSION") ??
    "";
  if (acceptVersion !== "" && !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(acceptVersion)) {
    fail(
      78,
      `CAPNP_WASM_WASMTIME_ACCEPT_VERSION must be an exact X.Y.Z version: ${acceptVersion}`,
    );
  }
  return {
    expectedVersion,
    timeout,
    maxMemory,
    maxWorkspace: Number(workspace),
    acceptVersion,
  };
}

function isExecutableFile(path: string): boolean {
  try {
    const info = Deno.statSync(path);
    return info.isFile && (WINDOWS || ((info.mode ?? 0) & 0o111) !== 0);
  } catch {
    return false;
  }
}

/** Like a shell's command lookup: PATH, and PATHEXT on Windows. */
function findExecutable(name: string): string | undefined {
  const extensions = WINDOWS
    ? [
      "",
      ...(Deno.env.get("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(
        Boolean,
      ),
    ]
    : [""];
  for (
    const directory of (Deno.env.get("PATH") ?? "").split(WINDOWS ? ";" : ":")
  ) {
    for (const extension of extensions) {
      const candidate = join(
        directory === "" ? "." : directory,
        name + extension,
      );
      if (isExecutableFile(candidate)) {
        return normalizePath(join(Deno.cwd(), candidate));
      }
    }
  }
  return undefined;
}

/** The absolute Wasmtime executable, checked against the packaged version. */
async function resolveRuntime(settings: Settings): Promise<string> {
  const expected = settings.expectedVersion;
  const requested = Deno.env.get("CAPNP_WASM_WASMTIME") ?? "wasmtime";
  let runtime: string | undefined;
  if (requested.includes("/") || (WINDOWS && requested.includes("\\"))) {
    runtime = normalizePath(join(Deno.cwd(), requested));
    if (!isExecutableFile(runtime)) runtime = undefined;
  } else {
    runtime = findExecutable(requested);
  }
  if (runtime === undefined) {
    fail(
      69,
      `Wasmtime ${expected} is required; executable not found: ${requested}`,
    );
  }
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command(runtime, {
      args: ["--version"],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(60_000),
    }).output();
  } catch {
    fail(69, "failed to read Wasmtime version");
  }
  if (!output.success) fail(69, "failed to read Wasmtime version");
  const banner =
    new TextDecoder().decode(output.stdout).trim().split(/\r?\n/)[0] ?? "";
  const match = /^wasmtime ([0-9]+\.[0-9]+\.[0-9]+)(?: .*)?$/.exec(banner);
  if (!match) fail(78, `expected Wasmtime ${expected}, got: ${banner}`);
  const actual = match[1];
  if (actual !== expected) {
    const [major, minor, patch] = actual.split(".").map(Number);
    const [wantMajor, wantMinor, wantPatch] = expected.split(".").map(Number);
    if (settings.acceptVersion !== "" && actual === settings.acceptVersion) {
      warn(
        `using Wasmtime ${actual} instead of the packaged ${expected} (CAPNP_WASM_WASMTIME_ACCEPT_VERSION)`,
      );
    } else if (
      major === wantMajor && minor === wantMinor && patch > wantPatch
    ) {
      warn(
        `using Wasmtime ${actual}, a newer patch release than the packaged ${expected}`,
      );
    } else {
      fail(
        78,
        `expected Wasmtime ${expected} (or a newer ${wantMajor}.${wantMinor} patch release), got: ${banner}`,
      );
    }
  }
  return runtime;
}

// ---------------------------------------------------------------------------
// Filesystem roots and staging.

function resolveRoot(kind: string, path: string): string {
  if (!isAbsolute(path) || path.includes("::")) {
    fail(64, `${kind} must be an absolute path without ::: ${path}`);
  }
  try {
    if (!Deno.statSync(path).isDirectory) throw new Error("not a directory");
    for (const _entry of Deno.readDirSync(path)) break;
  } catch {
    fail(66, `${kind} is not an accessible directory: ${path}`);
  }
  let resolved: string;
  try {
    resolved = realPath(path);
  } catch {
    fail(66, `${kind} cannot be resolved: ${path}`);
  }
  if (resolved.includes("::")) {
    fail(64, `resolved ${kind} contains ::: ${resolved}`);
  }
  if (parsePath(resolved).parts.length === 0) {
    fail(64, `refusing to use the filesystem root as the ${kind}`);
  }
  return resolved;
}

/**
 * Whether this user may write the entry, as access(2) answers it. On Windows
 * a read-only file is one that cannot be opened for writing; directories there
 * are always writable.
 */
function writable(path: string, info: Deno.FileInfo): boolean {
  if (WINDOWS) {
    if (!info.isFile) return true;
    try {
      Deno.openSync(path, { write: true }).close();
      return true;
    } catch {
      return false;
    }
  }
  const mode = info.mode ?? 0;
  const uid = Deno.uid();
  if (uid === 0) return true;
  if (uid === info.uid) return (mode & 0o200) !== 0;
  if (Deno.gid() === info.gid) return (mode & 0o020) !== 0;
  return (mode & 0o002) !== 0;
}

function makeWritable(path: string, info: Deno.FileInfo) {
  if (info.isSymlink) return;
  try {
    if (WINDOWS) {
      if (info.isFile) Deno.chmodSync(path, 0o666);
    } else {
      Deno.chmodSync(
        path,
        ((info.mode ?? 0) & 0o7777) | 0o600 | (info.isDirectory ? 0o100 : 0),
      );
    }
  } catch {
    // Best effort; removal reports nothing either.
  }
}

/** Removes a staging tree, write-protected or not. */
function removeTree(path: string) {
  const unlock = (target: string) => {
    const info = lstat(target);
    if (info === undefined) return;
    makeWritable(target, info);
    if (!info.isDirectory) return;
    try {
      for (const entry of Deno.readDirSync(target)) {
        unlock(join(target, entry.name));
      }
    } catch {
      // Removal below fails on what stays unreadable.
    }
  };
  unlock(path);
  try {
    Deno.removeSync(path, { recursive: true });
  } catch {
    // Best effort.
  }
}

/** Staging directories to remove when the launcher exits or is stopped. */
export class Cleanup {
  #paths: string[] = [];

  add(path: string): string {
    this.#paths.push(path);
    return path;
  }

  keep(path: string) {
    this.#paths = this.#paths.filter((entry) => entry !== path);
  }

  run() {
    while (this.#paths.length > 0) removeTree(this.#paths.pop()!);
  }
}

function makeStage(
  cleanup: Cleanup,
  parents: (string | undefined)[],
  prefix: string,
): string {
  for (const parent of parents) {
    let created: string;
    try {
      created = Deno.makeTempDirSync({ dir: parent, prefix });
    } catch {
      continue;
    }
    let stage: string;
    try {
      stage = realPath(created);
    } catch {
      removeTree(created);
      continue;
    }
    cleanup.add(stage);
    if (stage.includes("::")) fail(73, `staging path contains ::: ${stage}`);
    return stage;
  }
  fail(
    73,
    `cannot create a staging directory next to ${
      parents[0] ?? "the temporary directory"
    }`,
  );
}

function diskUsage(entries: Entry[]): number {
  return entries.reduce(
    (total, entry) =>
      total +
      (entry.info.blocks !== null ? entry.info.blocks * 512 : entry.info.size),
    0,
  );
}

async function copyTree(source: string, destination: string) {
  await Deno.mkdir(destination);
  for (const entry of await walk(source, false)) {
    checkStop();
    const target = join(destination, ...entry.parts);
    if (entry.info.isSymlink) {
      const link = await Deno.readLink(entry.path);
      let type: "file" | "dir" = "file";
      if (WINDOWS) {
        try {
          if ((await Deno.stat(entry.path)).isDirectory) type = "dir";
        } catch {
          // A dangling link stays a file link.
        }
      }
      await Deno.symlink(link, target, { type });
    } else if (entry.info.isDirectory) {
      await Deno.mkdir(target);
    } else if (entry.info.isFile) {
      await Deno.copyFile(entry.path, target);
    }
    // Sockets, FIFOs, and devices are not schema inputs; they are not copied.
  }
}

async function writeProtect(root: string) {
  const entries = await walk(root, false);
  for (
    const { path, info } of [...entries.reverse(), {
      path: root,
      info: Deno.lstatSync(root),
    }]
  ) {
    if (info.isSymlink) continue;
    if (WINDOWS) {
      if (info.isFile) Deno.chmodSync(path, 0o444);
    } else {
      Deno.chmodSync(path, (info.mode ?? 0) & 0o7777 & ~0o222);
    }
  }
}

/** The guest cannot follow absolute symlinks or symlinks that leave its root. */
async function warnEscapingSymlinks(root: string) {
  let shown = 0;
  for (const entry of await walk(root, true)) {
    if (!entry.info.isSymlink) continue;
    let target: string;
    let reason: string;
    try {
      target = await Deno.readLink(entry.path);
    } catch {
      continue;
    }
    if (
      target.startsWith("/") || isAbsolute(target) ||
      (WINDOWS && /^[\\/]/.test(target))
    ) {
      reason = "absolute symlinks cannot be followed by the guest";
    } else {
      let resolved: string;
      try {
        resolved = realPath(entry.path);
      } catch {
        continue; // A dangling link is reported by the guest if used.
      }
      if (isWithin(resolved, root)) continue;
      reason =
        "symlink leaves the workspace and cannot be followed by the guest";
    }
    if (shown < 8) warn(`${reason}: ${entry.parts.join("/")} -> ${target}`);
    shown++;
  }
  if (shown > 8) {
    warn(`${shown - 8} more symlinks cannot be followed by the guest`);
  }
}

/** Copies the workspace, write-protects the copy, and returns the guest root. */
async function stageWorkspace(
  cleanup: Cleanup,
  settings: Settings,
  workspace: string | undefined,
): Promise<string> {
  const stage = makeStage(cleanup, [undefined], "capnp-wasm.");
  const root = join(stage, "root");
  if (workspace === undefined) {
    try {
      Deno.mkdirSync(root);
    } catch {
      fail(73, `cannot create the empty workspace root: ${root}`);
    }
  } else {
    const resolved = resolveRoot("workspace", workspace);
    const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
    if (home) {
      try {
        if (resolved === realPath(home)) {
          warn(
            "the workspace is your home directory; the guest receives a read-only copy of it",
          );
        }
      } catch {
        // An unresolvable home directory is not the workspace.
      }
    }
    const entries = await walk(resolved, true, MAX_ENTRIES);
    if (entries.length > MAX_ENTRIES) {
      fail(
        73,
        `workspace has more than ${MAX_ENTRIES} entries; point --workspace at the schema directory: ${resolved}`,
      );
    }
    if (diskUsage(entries) > settings.maxWorkspace) {
      fail(
        73,
        `workspace uses more than CAPNP_WASM_MAX_WORKSPACE=${settings.maxWorkspace} bytes of disk; point --workspace at the schema directory: ${resolved}`,
      );
    }
    try {
      await copyTree(resolved, root);
    } catch (error) {
      if (error instanceof Stopped) throw error;
      fail(73, `cannot copy the workspace into ${stage}`);
    }
    await warnEscapingSymlinks(resolved);
  }
  try {
    await writeProtect(root);
  } catch (error) {
    if (error instanceof Stopped) throw error;
    fail(73, `cannot write-protect the workspace copy: ${root}`);
  }
  return root;
}

// ---------------------------------------------------------------------------
// Running a guest or a native generator.

interface ChildOptions {
  cwd: string;
  /** Written to the child's stdin; without it the child inherits stdin. */
  input?: Uint8Array;
  /** Collect the child's stdout instead of letting it inherit stdout. */
  capture?: boolean;
  /** Read Wasmtime's stderr as it passes through, to see a Windows trap. */
  trapScan?: boolean;
  startFailure?: number;
}

async function feed(stdin: WritableStream<Uint8Array>, data: Uint8Array) {
  const writer = stdin.getWriter();
  try {
    await writer.write(data);
    await writer.close();
  } catch {
    // The child stopped reading; its exit status reports why.
  }
}

async function collect(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    length += chunk.length;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function relayStderr(
  stream: ReadableStream<Uint8Array>,
  onTrap: () => void,
) {
  const decoder = new TextDecoder("latin1");
  let tail = "";
  for await (const chunk of stream) {
    writeAll(Deno.stderr, chunk);
    const window = tail + decoder.decode(chunk);
    if (window.includes("wasm trap") || window.includes("wasm backtrace")) {
      onTrap();
    }
    tail = window.slice(-64);
  }
}

/**
 * Runs a child process and returns its exit status and captured stdout. On
 * Windows a trap is reported as exit 3, as is a guest exit 3, so Wasmtime's
 * stderr is scanned for its trap report and a trap becomes exit 134.
 */
async function runChild(
  command: string[],
  options: ChildOptions,
): Promise<{ status: number; stdout: Uint8Array }> {
  checkStop();
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(command[0], {
      args: command.slice(1),
      cwd: options.cwd,
      stdin: options.input ? "piped" : "inherit",
      stdout: options.capture ? "piped" : "inherit",
      stderr: options.trapScan ? "piped" : "inherit",
    }).spawn();
  } catch (error) {
    fail(
      options.startFailure ?? 69,
      `cannot start ${basename(command[0])}: ${describe(error)}`,
    );
  }
  stopping.child = child;
  try {
    if (stopping.signal) child.kill("SIGTERM");
    let trapped = false;
    let stdout: Uint8Array = new Uint8Array();
    const streams: Promise<unknown>[] = [];
    if (options.input) streams.push(feed(child.stdin, options.input));
    if (options.capture) {
      streams.push(collect(child.stdout).then((data) => stdout = data));
    }
    if (options.trapScan) {
      streams.push(relayStderr(child.stderr, () => trapped = true));
    }
    const status = await child.status;
    await Promise.all(streams);
    checkStop();
    // A child stopped by signal N reports 128+N, as a shell would.
    const code = WINDOWS && options.trapScan && status.code === 3 && trapped
      ? 134
      : status.code;
    return { status: code, stdout };
  } finally {
    stopping.child = undefined;
  }
}

async function runGuest(
  runtime: string,
  settings: Settings,
  module: string,
  root: string,
  argv0: string,
  args: string[],
  options: { input?: Uint8Array; capture?: boolean } = {},
): Promise<{ status: number; stdout: Uint8Array }> {
  const bounds = [
    "-W",
    `max-wasm-stack=${MAX_WASM_STACK}`,
    "-W",
    `max-memory-size=${settings.maxMemory}`,
  ];
  if (settings.timeout !== "0") {
    bounds.push("-W", `timeout=${settings.timeout}s`);
  }
  // Run from the module's directory so Wasmtime's own failure text names only
  // the module file, not the host installation path; ./ keeps a name that
  // starts with - from being read as an option.
  const command = [
    runtime,
    "run",
    "-W",
    "exceptions=y",
    ...bounds,
    "-D",
    `max-backtrace=${MAX_BACKTRACE}`,
    "-S",
    "cwd=/",
    "--dir",
    `${root}::/`,
    `--argv0=${argv0}`,
    `.${WINDOWS ? "\\" : "/"}${basename(module)}`,
    ...args,
  ];
  return await runChild(command, {
    cwd: dirname(module),
    ...options,
    trapScan: WINDOWS,
  });
}

function checkModule(
  module: string,
  relativeAllowed = false,
): { module: string; argv0: string } {
  if (relativeAllowed) module = normalizePath(join(Deno.cwd(), module));
  else if (!isAbsolute(module)) {
    fail(64, `module must be an absolute path: ${module}`);
  }
  const head = new Uint8Array(4);
  let read = 0;
  try {
    if (!Deno.statSync(module).isFile) throw new Error("not a file");
    const file = Deno.openSync(module);
    try {
      while (read < head.length) {
        const count = file.readSync(head.subarray(read));
        if (count === null) break;
        read += count;
      }
    } finally {
      file.close();
    }
  } catch {
    fail(66, `module is not a readable file: ${module}`);
  }
  if (
    read < 4 || head[0] !== 0 || head[1] !== 0x61 || head[2] !== 0x73 ||
    head[3] !== 0x6d
  ) {
    fail(65, `module is not a WebAssembly binary: ${module}`);
  }
  if (dirname(module).includes("::")) {
    fail(64, `module path contains ::: ${module}`);
  }
  const name = basename(module);
  return {
    module,
    argv0: (name.endsWith(".wasm") ? name.slice(0, -5) : name) || "generator",
  };
}

// ---------------------------------------------------------------------------
// Publishing staged generator output. The check pass refuses symlinks produced
// by the guest, directory conflicts, read-only destinations, and symlinks at
// any destination or parent before anything moves. The move pass looks for
// symlinks again right before each move and, if a move still fails, keeps the
// staged output rather than deleting what was not published.

function symlinkInPath(output: string, parts: string[]): string | undefined {
  let path = output;
  for (const part of parts) {
    path = join(path, part);
    if (lstat(path)?.isSymlink) return path;
  }
  return undefined;
}

export async function publishOutput(
  cleanup: Cleanup,
  stage: string,
  output: string,
  rename: (from: string, to: string) => Promise<void> = Deno.rename,
): Promise<void> {
  const entries = await walk(stage, false);
  for (const entry of entries) {
    const destination = join(output, ...entry.parts);
    const bad = symlinkInPath(output, entry.parts);
    if (bad) fail(73, `output path is a symlink or below one: ${bad}`);
    if (entry.info.isSymlink) {
      fail(73, `generator produced a symlink: ${destination}`);
    }
    const existing = lstat(destination);
    if (entry.info.isDirectory) {
      if (
        existing && !(existing.isDirectory && writable(destination, existing))
      ) {
        fail(
          73,
          `output directory conflicts with an existing entry: ${destination}`,
        );
      }
    } else if (entry.info.isFile) {
      if (existing?.isDirectory) {
        fail(
          73,
          `output file conflicts with an existing directory: ${destination}`,
        );
      }
      if (existing && !writable(destination, existing)) {
        fail(73, `output file is read-only: ${destination}`);
      }
    } else {
      fail(73, `generator produced an unsupported entry: ${destination}`);
    }
  }
  const publishFail = (message: string): never => {
    cleanup.keep(stage);
    fail(73, `${message}; unpublished output kept in ${stage}`);
  };
  for (const entry of entries) {
    const destination = join(output, ...entry.parts);
    const bad = symlinkInPath(output, entry.parts);
    if (bad) publishFail(`output path became a symlink: ${bad}`);
    if (entry.info.isDirectory) {
      if (!lstat(destination)?.isDirectory) {
        try {
          await Deno.mkdir(destination);
        } catch {
          publishFail(`cannot create output directory: ${destination}`);
        }
      }
    } else {
      try {
        await rename(entry.path, destination);
      } catch {
        publishFail(`cannot publish output file: ${destination}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Paths relative to the current directory (capnp and generate modes).

function compilerOperation(args: string[]): [number, string] | undefined {
  for (const [index, arg] of args.entries()) {
    if (arg === "--") break;
    if (!arg.startsWith("-")) {
      return COMPILER_OPERATIONS.includes(arg) ? [index, arg] : undefined;
    }
  }
  return undefined;
}

/** [index, prefix, isDirectory] of every path argument, without interpreting
 * constant expressions or format names. */
export function compilerPathArguments(
  args: string[],
): [number, string, boolean][] {
  const found = compilerOperation(args);
  if (found === undefined) return [];
  const [operationIndex, operation] = found;
  const paths: [number, string, boolean][] = [];
  let position = 0;
  let options = true;
  for (let index = operationIndex + 1; index < args.length; index++) {
    const arg = args[index];
    if (options && arg === "--") {
      options = false;
    } else if (
      options && ["-I", "--import-path", "--src-prefix"].includes(arg)
    ) {
      index++;
      if (index < args.length) paths.push([index, "", true]);
    } else if (
      options &&
      (arg.startsWith("--import-path=") || arg.startsWith("--src-prefix="))
    ) {
      paths.push([index, `${arg.split("=")[0]}=`, true]);
    } else if (options && arg.startsWith("-I")) {
      paths.push([index, "-I", true]);
    } else if (options && ["-o", "--output", "--segment-size"].includes(arg)) {
      index++;
    } else if (options && arg.startsWith("-")) {
      // Another option; its value, if any, is attached.
    } else {
      if (
        operation === "compile" ||
        (["encode", "decode", "eval"].includes(operation) && position === 0) ||
        (operation === "convert" && position === 1)
      ) paths.push([index, "", false]);
      position++;
    }
  }
  return paths;
}

/**
 * Every filename, -I path, and --src-prefix shares one translation: the
 * deepest common directory of the current directory and every path argument
 * becomes guest /. KJ opens files through its one root directory, so a second
 * preopen cannot supply another tree. A compile without a source prefix that
 * covers the current directory gains --src-prefix for it, so requested file
 * names stay relative to the caller. `include`, when given, is added after
 * the caller's options as --no-standard-import -I<include>.
 */
export function translatePaths(
  args: string[],
  cwd: string,
  include?: string,
  windows = WINDOWS,
): { root: string; guestCwd: string; args: string[] } {
  cwd = normalizePath(cwd, windows);
  args = [...args];
  if (include !== undefined) {
    const end = args.includes("--") ? args.indexOf("--") : args.length;
    args.splice(end, 0, "--no-standard-import", `-I${include}`);
  }
  const roots = [cwd];
  const paths: [number, string, string][] = [];
  for (const [index, prefix, directory] of compilerPathArguments(args)) {
    const value = args[index].slice(prefix.length);
    if (value === "") continue; // Keep the compiler's own diagnostic.
    if (
      windows && splitDrive(value, true)[0] !== "" && !isAbsolute(value, true)
    ) {
      fail(
        64,
        `drive-relative paths are ambiguous; use an absolute path: ${value}`,
      );
    }
    const absolute = normalizePath(joinPath(cwd, value, windows), windows);
    roots.push(
      directory ? absolute : formatPath({
        ...parsePath(absolute, windows),
        parts: parsePath(absolute, windows).parts.slice(0, -1),
      }, windows),
    );
    paths.push([index, prefix, absolute]);
  }
  const root = commonPath(roots, windows);
  if (root === undefined) {
    fail(
      64,
      "schema and include paths must be on the current directory's volume; copy those inputs there first",
    );
  }
  if (root.includes("::")) {
    fail(64, `filesystem path cannot contain ::: ${root}`);
  }
  const result = [...args];
  for (const [index, prefix, absolute] of paths) {
    result[index] = prefix + guestPath(absolute, root, windows);
  }
  if (compilerOperation(args)?.[1] === "compile" && paths.length > 0) {
    const prefixes = paths.filter(([index, prefix]) =>
      prefix === "--src-prefix=" ||
      (prefix === "" && index > 0 && args[index - 1] === "--src-prefix")
    ).map(([, , absolute]) => absolute);
    if (!prefixes.some((prefix) => isWithin(cwd, prefix, windows))) {
      const end = result.includes("--") ? result.indexOf("--") : result.length;
      result.splice(end, 0, `--src-prefix=${guestPath(cwd, root, windows)}`);
    }
  }
  return { root, guestCwd: guestPath(cwd, root, windows), args: result };
}

export function needsStandardImport(args: string[]): boolean {
  const end = args.includes("--") ? args.indexOf("--") : args.length;
  const options = args.slice(0, end);
  return INCLUDE_OPERATIONS.includes(compilerOperation(args)?.[1] ?? "") &&
    !options.includes("--no-standard-import") &&
    !options.some((arg) => arg === "--version" || arg === "--help");
}

async function copyIncludes(source: string, destination: string) {
  await Deno.mkdir(destination);
  for (const entry of await walk(source, false)) {
    const target = join(destination, ...entry.parts);
    if (entry.info.isDirectory) await Deno.mkdir(target);
    else await Deno.copyFile(entry.path, target);
  }
}

/** Runs the compiler on caller-relative paths. */
async function runCapnp(
  cleanup: Cleanup,
  pkg: string,
  runtime: string,
  settings: Settings,
  args: string[],
  capture = false,
): Promise<{ status: number; stdout: Uint8Array }> {
  const cwd = realPath(Deno.cwd());
  let include: string | undefined;
  if (needsStandardImport(args)) {
    include = join(pkg, "include");
    if (!isWithin(include, translatePaths(args, cwd).root)) {
      // Stage the small bundled schema tree under the current directory, so
      // it shares the caller's root instead of widening it.
      const staged = makeStage(cleanup, [cwd], ".capnp-wasm-include.");
      include = join(staged, "include");
      try {
        await copyIncludes(join(pkg, "include"), include);
      } catch {
        fail(73, `cannot stage the bundled schemas in ${staged}`);
      }
    }
  }
  const { root, args: translated } = translatePaths(args, cwd, include);
  return await runGuest(
    runtime,
    settings,
    join(pkg, "wasm", "capnp.wasm"),
    root,
    "capnp",
    translated,
    { capture },
  );
}

async function generate(
  cleanup: Cleanup,
  pkg: string,
  runtime: string,
  settings: Settings,
  options: Map<string, string[]>,
  schemaArgs: string[],
): Promise<number> {
  const pluginArgs = options.get("--plugin-arg") ?? [];
  let module: { module: string; argv0: string } | undefined;
  let plugin: string | undefined;
  if (options.has("--module")) {
    module = checkModule(options.get("--module")![0], true);
  } else {
    plugin = normalizePath(join(Deno.cwd(), options.get("--plugin")![0]));
    if (
      WINDOWS && lstat(plugin) === undefined &&
      !plugin.toLowerCase().endsWith(".exe")
    ) plugin += ".exe";
    if (!isExecutableFile(plugin)) {
      fail(66, `native generator is not an executable file: ${plugin}`);
    }
  }
  let output = normalizePath(join(Deno.cwd(), options.get("--output")![0]));
  if (output.includes("::")) {
    fail(64, `output directory cannot contain ::: ${output}`);
  }
  try {
    await Deno.mkdir(output, { recursive: true });
  } catch {
    fail(73, `cannot create the output directory: ${output}`);
  }
  output = resolveRoot("output directory", output);
  if (!writable(output, Deno.statSync(output))) {
    fail(73, `output directory is not writable: ${output}`);
  }
  // The generator runs only after a successful compile.
  const compiled = await runCapnp(cleanup, pkg, runtime, settings, [
    "compile",
    "-o-",
    ...schemaArgs,
  ], true);
  if (compiled.status !== 0) return compiled.status;
  const stage = makeStage(cleanup, [dirname(output), output], ".capnp-wasm.");
  const { status } = module
    ? await runGuest(
      runtime,
      settings,
      module.module,
      stage,
      module.argv0,
      pluginArgs,
      { input: compiled.stdout },
    )
    : await runChild([plugin!, ...pluginArgs], {
      cwd: stage,
      input: compiled.stdout,
      startFailure: 66,
    });
  checkStop();
  if (status === 0) await publishOutput(cleanup, stage, output);
  return status;
}

// ---------------------------------------------------------------------------
// Modes.

function parseOptions(
  args: string[],
  allowed: string[],
  repeatable: string[] = [],
): [Map<string, string[]>, string[]] {
  const options = new Map<string, string[]>();
  for (let index = 0; index < args.length;) {
    const arg = args[index];
    if (arg === "--") return [options, args.slice(index + 1)];
    const equals = arg.indexOf("=");
    if (equals > 0 && repeatable.includes(arg.slice(0, equals))) {
      const name = arg.slice(0, equals);
      options.set(name, [...options.get(name) ?? [], arg.slice(equals + 1)]);
      index++;
      continue;
    }
    if (!allowed.includes(arg) || index + 1 >= args.length) fail(64, USAGE);
    if (!repeatable.includes(arg) && options.has(arg)) fail(64, USAGE);
    options.set(arg, [...options.get(arg) ?? [], args[index + 1]]);
    index += 2;
  }
  fail(64, "missing -- before command arguments");
}

function writeStdout(text: string) {
  writeAll(Deno.stdout, encoder.encode(text));
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0) fail(64, USAGE);
  const [mode, ...args] = argv;
  if (["--help", "-h", "help"].includes(mode)) {
    writeStdout(`${HELP}\n`);
    return 0;
  }
  checkDeno();
  const pkg = packageRoot();
  if (mode === "--version" || mode === "version") {
    writeStdout(`capnp-wasm ${packageVersion(pkg)}\n`);
    try {
      writeStdout(
        `wasmtime ${
          Deno.readTextFileSync(join(pkg, "runtime", "wasmtime-version")).trim()
        }\n`,
      );
    } catch {
      // A package without a launcher runtime prints only its own version.
    }
    return 0;
  }
  if (mode === "verify") {
    let expect: string | undefined;
    if (args.length > 0) {
      if (
        args.length !== 2 || args[0] !== "--expect-manifest-sha256" ||
        !/^[0-9a-fA-F]{64}$/.test(args[1])
      ) {
        fail(64, USAGE);
      }
      expect = args[1].toLowerCase();
    }
    const { manifest, digest } = await verifyPackage(
      pkg,
      expect ?? expectedManifestDigest(),
    );
    writeStdout(
      `verified ${manifest.name} ${manifest.version}: ${manifest.files.length} files, manifest.json sha256 ${digest}\n`,
    );
    return 0;
  }
  let options: Map<string, string[]>;
  let rest: string[];
  if (mode === "compiler") {
    [options, rest] = parseOptions(args, ["--workspace"]);
    if (rest.length === 0) fail(64, "missing compiler arguments");
  } else if (mode === "generator") {
    [options, rest] = parseOptions(args, ["--module", "--output"]);
    if (!options.has("--module") || !options.has("--output")) fail(64, USAGE);
  } else if (mode === "capnp") {
    [options, rest] = parseOptions(args, []);
    if (rest.length === 0) fail(64, "missing compiler arguments");
  } else if (mode === "generate") {
    [options, rest] = parseOptions(args, [
      "--module",
      "--plugin",
      "--output",
      "--plugin-arg",
    ], ["--plugin-arg"]);
    if (
      options.has("--module") === options.has("--plugin") ||
      !options.has("--output")
    ) fail(64, USAGE);
    if (rest.length === 0) fail(64, "missing schema arguments");
    const end = rest.includes("--") ? rest.indexOf("--") : rest.length;
    if (
      rest[0] === "compile" ||
      rest.slice(0, end).some((arg) =>
        arg === "-o" || arg === "--output" || arg.startsWith("-o") ||
        arg.startsWith("--output=")
      )
    ) fail(64, "generate supplies compile -o-; give only the schema arguments");
  } else {
    fail(64, USAGE);
  }

  const expect = expectedManifestDigest();
  const settings = readSettings(pkg);
  await verifyPackage(pkg, expect);
  const runtime = await resolveRuntime(settings);
  const cleanup = new Cleanup();
  try {
    if (mode === "compiler") {
      const root = await stageWorkspace(
        cleanup,
        settings,
        options.get("--workspace")?.[0],
      );
      return (await runGuest(
        runtime,
        settings,
        join(pkg, "wasm", "capnp.wasm"),
        root,
        "capnp",
        rest,
      )).status;
    }
    if (mode === "generator") {
      const { module, argv0 } = checkModule(options.get("--module")![0]);
      const output = resolveRoot(
        "output directory",
        options.get("--output")![0],
      );
      if (!writable(output, Deno.statSync(output))) {
        fail(73, `output directory is not writable: ${output}`);
      }
      const stage = makeStage(
        cleanup,
        [dirname(output), output],
        ".capnp-wasm.",
      );
      const { status } = await runGuest(
        runtime,
        settings,
        module,
        stage,
        argv0,
        rest,
      );
      if (status === 0) await publishOutput(cleanup, stage, output);
      return status;
    }
    if (mode === "capnp") {
      return (await runCapnp(cleanup, pkg, runtime, settings, rest)).status;
    }
    return await generate(cleanup, pkg, runtime, settings, options, rest);
  } finally {
    cleanup.run();
  }
}

export async function cli(argv: string[]): Promise<number> {
  const uninstall = installStopListeners();
  try {
    return await main(argv);
  } catch (error) {
    if (error instanceof Stopped) {
      uninstall();
      const number = SIGNAL_NUMBERS[error.signal] ?? 15;
      if (!WINDOWS) {
        // Stop with the same signal, as a shell expects of its children.
        Deno.kill(Deno.pid, error.signal);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return 128 + number;
    }
    if (error instanceof Failure) {
      say(error.message);
      return error.code;
    }
    say(describe(error));
    return 1;
  } finally {
    uninstall();
  }
}

if (import.meta.main) Deno.exit(await cli(Deno.args));
