// Tests for bin/capnp-wasm.ts that run on Linux, macOS, and Windows.
//
// tests/package/launcher.ts checks the whole launcher contract on Linux and
// macOS. This file covers the launcher's own additions (package verification,
// the capnp and generate modes, path translation including Windows paths, and
// a publication that fails part-way) and is the Windows acceptance test for the
// release workflow's archives. It imports nothing outside this file and the
// launcher.
//
//   CAPNP_WASM_TEST_PACKAGE=/abs/package \
//   CAPNP_WASM_TEST_MODULES=/abs/dir/with/capnpc-zig.wasm \
//   deno test --allow-all --no-config tests/package/portable_launcher_test.ts
//
// Without CAPNP_WASM_TEST_PACKAGE only the unit tests run, against
// bin/capnp-wasm.ts in this checkout. Wasmtime must be on PATH (or named by
// CAPNP_WASM_WASMTIME) for the end-to-end tests.

const PACKAGE = Deno.env.get("CAPNP_WASM_TEST_PACKAGE");
const MODULES = Deno.env.get("CAPNP_WASM_TEST_MODULES");
const WINDOWS = Deno.build.os === "windows";
const SEPARATOR = WINDOWS ? "\\" : "/";

function join(...parts: string[]): string {
  return parts.join(SEPARATOR);
}

function fileUrl(path: string): string {
  const absolute = path.replaceAll("\\", "/");
  return new URL(
    `file://${absolute.startsWith("/") ? "" : "/"}${
      encodeURI(absolute).replaceAll("#", "%23").replaceAll("?", "%3F")
    }`,
  ).href;
}

const script = PACKAGE
  ? join(PACKAGE, "bin", "capnp-wasm.ts")
  : new URL("../../bin/capnp-wasm.ts", import.meta.url).href;
const launcher: typeof import("../../bin/capnp-wasm.ts") = await import(
  PACKAGE ? fileUrl(script) : script
);

const text = new TextDecoder();
const bytes = new TextEncoder();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, label = "value") {
  const [a, b] = [JSON.stringify(actual), JSON.stringify(expected)];
  assert(a === b, `${label}: expected ${b}, got ${a}`);
}

function assertFailure(run: () => unknown, code: number) {
  try {
    run();
  } catch (error) {
    assert(
      error instanceof launcher.Failure,
      `not a launcher failure: ${error}`,
    );
    assertEquals(error.code, code, "failure code");
    return;
  }
  throw new Error(`expected a failure with exit ${code}`);
}

const SCHEMA = `@0xb1c2d3e4f5a6b7c8;
struct Checkpoint {
  timeline @0 :UInt64;
  pos @1 :UInt32;
  prefix @2 :UInt64;
  state @3 :Data;
  status @4 :Status;
  struct Status { kind @0 :UInt8; message @1 :Text; }
}
`;

const IMPORTING = `@0xe1e2f3a4b5c6d7e9;
using Cxx = import "/capnp/c++.capnp";
using import "b.capnp".B;
$Cxx.namespace("probe");
struct A { b @0 :B; n @1 :UInt32; }
`;

const IMPORTED = `@0xd1e2f3a4b5c6d7e8;
struct B { value @0 :Text; }
`;

// (module (func (export "_start") (loop (br 0))))
const LOOP_MODULE = new Uint8Array(
  [
    "0061736d01000000",
    "010401600000",
    "03020100",
    "070a01065f73746172740000",
    "0a090107000340",
    "0c000b0b",
  ].join("").match(/../g)!.map((pair) => parseInt(pair, 16)),
);

// ---------------------------------------------------------------------------
// Path translation, as capnp-zig's driver tested it.

const translate = (
  args: string[],
  cwd: string,
  windows: boolean,
  include?: string,
) => launcher.translatePaths(args, cwd, include, windows);

Deno.test("a relative POSIX schema gains a source prefix", () => {
  const { root, guestCwd, args } = translate(
    ["compile", "-o-", "schema/checkpoint.capnp"],
    "/work/project",
    false,
  );
  assertEquals(root, "/work/project");
  assertEquals(guestCwd, "/");
  assertEquals(args, [
    "compile",
    "-o-",
    "/schema/checkpoint.capnp",
    "--src-prefix=/",
  ]);
});

Deno.test("parent paths widen the root", () => {
  const { root, guestCwd, args } = translate(
    ["compile", "-o-", "-I../shared", "../schema/a.capnp"],
    "/work/project",
    false,
  );
  assertEquals(root, "/work");
  assertEquals(guestCwd, "/project");
  assertEquals(args, [
    "compile",
    "-o-",
    "-I/shared",
    "/schema/a.capnp",
    "--src-prefix=/project",
  ]);
});

Deno.test("an explicit ancestor prefix is kept alone", () => {
  const { args } = translate(
    ["compile", "-o-", "--src-prefix=.", "schema/a.capnp"],
    "/work/project",
    false,
  );
  assertEquals(args, ["compile", "-o-", "--src-prefix=/", "/schema/a.capnp"]);
});

Deno.test("a descendant prefix still gains the current directory's prefix", () => {
  const { args } = translate(
    ["compile", "-o-", "--src-prefix", "schema", "schema/a.capnp"],
    "/work/project",
    false,
  );
  assertEquals(args, [
    "compile",
    "-o-",
    "--src-prefix",
    "/schema",
    "/schema/a.capnp",
    "--src-prefix=/",
  ]);
});

Deno.test("the bundled include goes after the caller's options", () => {
  const { args } = translate(
    ["compile", "-o-", "-Isrc", "a.capnp", "--", "b.capnp"],
    "/p",
    false,
    "/p/inc",
  );
  assertEquals(args, [
    "compile",
    "-o-",
    "-I/src",
    "/a.capnp",
    "--no-standard-import",
    "-I/inc",
    "--src-prefix=/",
    "--",
    "/b.capnp",
  ]);
});

Deno.test("encode translates only the schema file", () => {
  assertEquals(
    translate(["encode", "schema/a.capnp", "Type"], "/p", false).args,
    ["encode", "/schema/a.capnp", "Type"],
  );
});

Deno.test("convert translates its schema position", () => {
  assertEquals(
    translate(["convert", "text:binary", "schema/a.capnp", "Type"], "/p", false)
      .args,
    ["convert", "text:binary", "/schema/a.capnp", "Type"],
  );
});

Deno.test("Windows paths use forward slashes in the guest", () => {
  const { root, guestCwd, args } = translate(
    ["compile", "-o-", "schema\\checkpoint.capnp"],
    "C:\\work\\project",
    true,
  );
  assertEquals(root, "C:\\work\\project");
  assertEquals(guestCwd, "/");
  assertEquals(args, [
    "compile",
    "-o-",
    "/schema/checkpoint.capnp",
    "--src-prefix=/",
  ]);
});

Deno.test("a Windows drive-relative path is refused", () => {
  assertFailure(
    () => translate(["compile", "-o-", "D:schema.capnp"], "C:\\work", true),
    64,
  );
});

Deno.test("a second Windows volume is refused", () => {
  assertFailure(
    () => translate(["compile", "-o-", "D:\\schema.capnp"], "C:\\work", true),
    64,
  );
});

Deno.test("a Windows absolute path on the same volume", () => {
  const { root, args } = translate(
    ["compile", "-o-", "C:\\shared\\a.capnp"],
    "C:\\work\\project",
    true,
  );
  assertEquals(root, "C:\\");
  assertEquals(args.slice(0, 3), ["compile", "-o-", "/shared/a.capnp"]);
});

Deno.test("Windows paths compare without case and keep the caller's spelling", () => {
  const { root, args } = translate(
    ["compile", "-o-", "c:\\WORK\\shared\\a.capnp"],
    "C:\\Work\\Project",
    true,
  );
  assertEquals(root, "C:\\Work");
  assertEquals(args, [
    "compile",
    "-o-",
    "/shared/a.capnp",
    "--src-prefix=/Project",
  ]);
});

Deno.test("Windows UNC and verbatim paths", () => {
  const unc = translate(
    ["compile", "-o-", "a.capnp"],
    "\\\\server\\share\\work",
    true,
  );
  assertEquals(unc.root, "\\\\server\\share\\work");
  assertEquals(unc.args, ["compile", "-o-", "/a.capnp", "--src-prefix=/"]);
  const verbatim = translate(
    ["compile", "-o-", "a.capnp"],
    "\\\\?\\C:\\work",
    true,
  );
  assertEquals(verbatim.root, "C:\\work");
});

Deno.test("--version takes no paths", () => {
  assertEquals(launcher.compilerPathArguments(["--version"]), []);
  assert(
    !launcher.needsStandardImport(["compile", "--version"]),
    "compile --version",
  );
  assert(
    !launcher.needsStandardImport([
      "compile",
      "--no-standard-import",
      "a.capnp",
    ]),
    "--no-standard-import",
  );
  assert(
    launcher.needsStandardImport(["compile", "-o-", "a.capnp"]),
    "compile",
  );
});

// ---------------------------------------------------------------------------
// Publication.

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("a move that fails part-way keeps the staged output and names it", async () => {
  const scratch = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "capnp wasm publish " }),
  );
  try {
    const stage = join(scratch, ".capnp-wasm.stage");
    const output = join(scratch, "output");
    await Deno.mkdir(stage);
    await Deno.mkdir(output);
    const files = [
      "first.capnp.c++",
      "first.capnp.h",
      "seco.capnp.c++",
      "seco.capnp.h",
    ];
    for (const file of files) {
      await Deno.writeTextFile(join(stage, file), `${file}\n`);
    }
    const cleanup = new launcher.Cleanup();
    cleanup.add(stage);
    let failure: unknown;
    try {
      await launcher.publishOutput(cleanup, stage, output, async (from, to) => {
        if (from.endsWith("seco.capnp.h")) throw new Error("simulated failure");
        await Deno.rename(from, to);
      });
    } catch (error) {
      failure = error;
    }
    assert(
      failure instanceof launcher.Failure,
      `publication did not fail: ${failure}`,
    );
    assertEquals(failure.code, 73, "exit status");
    assert(
      failure.message.includes(`unpublished output kept in ${stage}`),
      `the message does not name the staging directory: ${failure.message}`,
    );
    cleanup.run();
    for (const file of files) {
      assert(
        (await exists(join(stage, file))) !==
          (await exists(join(output, file))),
        `${file} is not in exactly one of the output and the kept staging directory`,
      );
    }
    assert(
      await exists(join(stage, "seco.capnp.h")),
      "the file whose move failed was not kept",
    );
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// End to end, against an extracted package.

interface Result {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}

async function runLauncher(
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    input?: Uint8Array;
    script?: string;
    flags?: string[];
  } = {},
): Promise<Result> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      ...(options.flags ?? ["--allow-all"]),
      "--no-config",
      options.script ?? script,
      ...args,
    ],
    cwd: options.cwd,
    env: options.env,
    stdin: options.input ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (options.input) {
    const writer = child.stdin.getWriter();
    await writer.write(options.input).catch(() => {});
    await writer.close().catch(() => {});
  }
  const output = await child.output();
  return {
    code: output.code,
    stdout: output.stdout,
    stderr: text.decode(output.stderr),
  };
}

function assertStatus(result: Result, code: number, label: string) {
  assert(
    result.code === code,
    `${label}: expected exit ${code}, got ${result.code}: ${result.stderr}`,
  );
}

async function copyTree(source: string, destination: string) {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory) await copyTree(from, to);
    else await Deno.copyFile(from, to);
  }
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(data)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function endToEnd(
  name: string,
  fn: (scratch: string) => Promise<void>,
  needsModules = false,
) {
  Deno.test({
    name,
    ignore: !PACKAGE || (needsModules && !MODULES),
    fn: async () => {
      const scratch = await Deno.realPath(
        await Deno.makeTempDir({ prefix: "capnp wasm launcher " }),
      );
      try {
        await fn(scratch);
      } finally {
        await Deno.remove(scratch, { recursive: true }).catch(() => {});
      }
    },
  });
}

async function write(path: string, content: string | Uint8Array) {
  await Deno.mkdir(path.slice(0, path.lastIndexOf(SEPARATOR)), {
    recursive: true,
  });
  if (typeof content === "string") await Deno.writeTextFile(path, content);
  else await Deno.writeFile(path, content);
  return path;
}

endToEnd("verify and --version", async (scratch) => {
  const verified = await runLauncher(["verify"], { cwd: scratch });
  assertStatus(verified, 0, "verify");
  const digest = await sha256(
    await Deno.readFile(join(PACKAGE!, "manifest.json")),
  );
  assert(
    text.decode(verified.stdout).includes(digest),
    "verify does not print the manifest digest",
  );
  assertStatus(
    await runLauncher(["verify", "--expect-manifest-sha256", digest]),
    0,
    "expected digest",
  );
  assertStatus(
    await runLauncher(["verify", "--expect-manifest-sha256", "0".repeat(64)]),
    74,
    "another digest",
  );
  const version = await runLauncher(["--version"]);
  assertStatus(version, 0, "--version");
  const packageVersion =
    JSON.parse(await Deno.readTextFile(join(PACKAGE!, "package.json"))).version;
  assert(
    text.decode(version.stdout).includes(`capnp-wasm ${packageVersion}`),
    "--version output",
  );
});

endToEnd("a tampered copy fails verification", async (scratch) => {
  const copy = join(scratch, "package copy");
  await copyTree(PACKAGE!, copy);
  const include = join(copy, "include", "capnp", "c++.capnp");
  await Deno.writeFile(
    include,
    new Uint8Array([...await Deno.readFile(include), 10]),
  );
  const result = await runLauncher(["compiler", "--", "--version"], {
    script: join(copy, "bin", "capnp-wasm.ts"),
  });
  assertStatus(result, 74, "tampered copy");
  assert(result.stderr.includes("package integrity mismatch"), result.stderr);
});

endToEnd(
  "missing Deno permissions fail before anything runs",
  async (scratch) => {
    const result = await runLauncher(["compiler", "--", "--version"], {
      cwd: scratch,
      flags: ["--allow-read", "--no-prompt"],
    });
    assertStatus(result, 78, "read-only permissions");
    assert(result.stderr.includes("--allow-all"), result.stderr);
  },
);

endToEnd("the capnp mode matches the workspace flow", async (scratch) => {
  const project = join(scratch, "project");
  await write(join(project, "schema", "checkpoint.capnp"), SCHEMA);
  const relative = await runLauncher(
    [
      "capnp",
      "--",
      "compile",
      "-o-",
      "--src-prefix=schema",
      join("schema", "checkpoint.capnp"),
    ],
    { cwd: project },
  );
  assertStatus(relative, 0, "capnp mode");
  const workspace = join(scratch, "workspace");
  await copyTree(join(PACKAGE!, "include"), join(workspace, "include"));
  await Deno.copyFile(
    join(project, "schema", "checkpoint.capnp"),
    join(workspace, "checkpoint.capnp"),
  );
  const staged = await runLauncher([
    "compiler",
    "--workspace",
    workspace,
    "--",
    "compile",
    "--no-standard-import",
    "-I/include",
    "--src-prefix=/",
    "-o-",
    "/checkpoint.capnp",
  ]);
  assertStatus(staged, 0, "compiler mode");
  assert(relative.stdout.length > 0, "empty request");
  assertEquals(
    await sha256(relative.stdout),
    await sha256(staged.stdout),
    "request digest",
  );
  const left = [];
  for await (const entry of Deno.readDir(project)) left.push(entry.name);
  assertEquals(left, ["schema"], "staged schemas were left behind");
});

endToEnd(
  "the capnp mode resolves standard and sibling imports",
  async (scratch) => {
    const project = join(scratch, "project");
    await write(join(project, "tests", "schemas", "a.capnp"), IMPORTING);
    await write(join(project, "tests", "schemas", "b.capnp"), IMPORTED);
    const result = await runLauncher([
      "capnp",
      "--",
      "compile",
      "-o-",
      "tests/schemas/a.capnp",
    ], {
      cwd: project,
    });
    assertStatus(result, 0, "imports");
    assert(
      text.decode(result.stdout).includes("tests/schemas/a.capnp"),
      "requested file name",
    );
    const missing = await runLauncher(
      [
        "capnp",
        "--",
        "compile",
        "--no-standard-import",
        "-o-",
        "tests/schemas/a.capnp",
      ],
      { cwd: project },
    );
    assertStatus(missing, 1, "without the standard import");
  },
);

endToEnd(
  "generate with a Wasm generator matches the generator mode",
  async (scratch) => {
    const project = join(scratch, "project");
    await write(join(project, "schema", "checkpoint.capnp"), SCHEMA);
    const module = join(MODULES!, "capnpc-zig.wasm");
    const generated = await runLauncher([
      "generate",
      "--module",
      module,
      "--output",
      "gen",
      "--",
      "--src-prefix=schema",
      "schema/checkpoint.capnp",
    ], { cwd: project });
    assertStatus(generated, 0, "generate");
    const first = await Deno.readFile(join(project, "gen", "checkpoint.zig"));
    assert(
      text.decode(first).includes("pub const Checkpoint = struct"),
      "no Checkpoint struct",
    );
    const request = await runLauncher(
      [
        "capnp",
        "--",
        "compile",
        "-o-",
        "--src-prefix=schema",
        "schema/checkpoint.capnp",
      ],
      { cwd: project },
    );
    assertStatus(request, 0, "request");
    const output = join(scratch, "generator output");
    await Deno.mkdir(output);
    const direct = await runLauncher([
      "generator",
      "--module",
      module,
      "--output",
      output,
      "--",
    ], {
      input: request.stdout,
    });
    assertStatus(direct, 0, "generator mode");
    assertEquals(
      await sha256(await Deno.readFile(join(output, "checkpoint.zig"))),
      await sha256(first),
      "generated file digest",
    );
    const compact = await runLauncher([
      "generate",
      "--module",
      module,
      "--output",
      "compact",
      "--plugin-arg=--api-profile=compact",
      "--",
      "--src-prefix=schema",
      "schema/checkpoint.capnp",
    ], { cwd: project });
    assertStatus(compact, 0, "compact");
    assert(
      await sha256(
        await Deno.readFile(join(project, "compact", "checkpoint.zig")),
      ) !== await sha256(first),
      "--plugin-arg did not reach the generator",
    );
    const failed = await runLauncher(
      [
        "generate",
        "--module",
        module,
        "--output",
        "never",
        "--",
        "schema/missing.capnp",
      ],
      { cwd: project },
    );
    assertStatus(failed, 1, "missing schema");
    const never = [];
    for await (const entry of Deno.readDir(join(project, "never"))) {
      never.push(
        entry.name,
      );
    }
    assertEquals(never, [], "output after a failed compile");
  },
  true,
);

endToEnd("usage and input errors", async (scratch) => {
  assertStatus(await runLauncher([]), 64, "no mode");
  assertStatus(await runLauncher(["build"]), 64, "unknown mode");
  assertStatus(await runLauncher(["capnp"]), 64, "capnp without arguments");
  assertStatus(
    await runLauncher(["generate", "--output", "x", "--", "a.capnp"]),
    64,
    "no generator",
  );
  assertStatus(
    await runLauncher([
      "generate",
      "--module",
      "m.wasm",
      "--output",
      "x",
      "--",
      "compile",
      "a.capnp",
    ]),
    64,
    "compile in schema arguments",
  );
  assertStatus(
    await runLauncher([
      "compiler",
      "--workspace",
      "relative",
      "--",
      "--version",
    ]),
    64,
    "relative workspace",
  );
  const notWasm = await write(join(scratch, "not a module.wasm"), "not wasm");
  const output = join(scratch, "out");
  await Deno.mkdir(output);
  assertStatus(
    await runLauncher([
      "generator",
      "--module",
      notWasm,
      "--output",
      output,
      "--",
    ]),
    65,
    "not a module",
  );
  assertStatus(
    await runLauncher([
      "generator",
      "--module",
      `${notWasm}.missing`,
      "--output",
      output,
      "--",
    ]),
    66,
    "missing module",
  );
  assertStatus(
    await runLauncher(["compiler", "--", "--version"], {
      env: { CAPNP_WASM_TIMEOUT: "1.5" },
    }),
    78,
    "invalid timeout",
  );
  assertStatus(
    await runLauncher(["compiler", "--", "--version"], {
      env: { CAPNP_WASM_WASMTIME: join(scratch, "none") },
    }),
    69,
    "missing Wasmtime",
  );
});

endToEnd("guest status and trap", async (scratch) => {
  const loop = await write(join(scratch, "modules", "loop.wasm"), LOOP_MODULE);
  const output = join(scratch, "out");
  await Deno.mkdir(output);
  const trapped = await runLauncher([
    "generator",
    "--module",
    loop,
    "--output",
    output,
    "--",
  ], {
    env: { CAPNP_WASM_TIMEOUT: "1" },
  });
  assertStatus(trapped, 134, "timeout");
  assert(trapped.stderr.includes("wasm trap"), trapped.stderr);
  const left = [];
  for await (const entry of Deno.readDir(output)) left.push(entry.name);
  assertEquals(left, [], "output after a trap");
  const bad = await runLauncher(["compiler", "--", "compile", "--bogus"]);
  assertStatus(bad, 1, "bad compiler option");
  assert(bad.stderr.includes("capnp compile"), bad.stderr);
});

endToEnd("the compiler workspace stays unchanged", async (scratch) => {
  const workspace = join(scratch, "workspace");
  await write(join(workspace, "checkpoint.capnp"), SCHEMA);
  const result = await runLauncher([
    "compiler",
    "--workspace",
    workspace,
    "--",
    "compile",
    "--no-standard-import",
    "-o-",
    "/checkpoint.capnp",
  ]);
  assertStatus(result, 0, "compile");
  const names = [];
  for await (const entry of Deno.readDir(workspace)) names.push(entry.name);
  assertEquals(names, ["checkpoint.capnp"], "workspace entries");
  assertEquals(
    await Deno.readTextFile(join(workspace, "checkpoint.capnp")),
    SCHEMA,
    "workspace file",
  );
  assert(bytes.encode(SCHEMA).length > 0, "schema");
});
