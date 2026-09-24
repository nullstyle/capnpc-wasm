import { packageFiles } from "../../scripts/verify-release.ts";

const text = new TextDecoder();
const bytes = new TextEncoder();

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

interface RunOptions {
  input?: Uint8Array;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

async function run(
  args: string[],
  options: RunOptions = {},
): Promise<Deno.CommandOutput> {
  const child = new Deno.Command(args[0], {
    args: args.slice(1),
    env: options.env,
    cwd: options.cwd,
    stdin: options.input ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  }).spawn();
  const output = child.output();
  if (options.input) {
    try {
      await new Blob([new Uint8Array(options.input)]).stream().pipeTo(
        child.stdin,
      );
    } catch (error) {
      if (!(error instanceof Deno.errors.BrokenPipe)) throw error;
    }
  }
  return await output;
}

function success(output: Deno.CommandOutput): Uint8Array {
  assert(output.success, text.decode(output.stderr));
  return output.stdout;
}

function exitCode(output: Deno.CommandOutput, code: number, label: string) {
  assert(
    output.code === code,
    `${label}: expected exit ${code}, got ${output.code}: ${
      text.decode(output.stderr)
    }`,
  );
}

function equal(actual: Uint8Array, expected: Uint8Array, label: string) {
  assert(
    actual.length === expected.length &&
      actual.every((value, index) => value === expected[index]),
    `${label}: bytes differ`,
  );
}

function stderrOf(output: Deno.CommandOutput): string {
  return text.decode(output.stderr);
}

async function sha256(data: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(data)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Every entry below a directory: kind, mode, symlink target, and file digest. */
async function snapshot(
  root: string,
  prefix = "",
): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  for await (const entry of Deno.readDir(root)) {
    const path = `${root}/${entry.name}`;
    const relative = `${prefix}${entry.name}`;
    const info = await Deno.lstat(path);
    if (info.isSymlink) {
      entries.set(relative, `link:${await Deno.readLink(path)}`);
    } else if (info.isDirectory) {
      entries.set(relative, `dir:${info.mode ?? 0}`);
      for (const [key, value] of await snapshot(path, `${relative}/`)) {
        entries.set(key, value);
      }
    } else {
      entries.set(
        relative,
        `file:${info.mode ?? 0}:${await sha256(await Deno.readFile(path))}`,
      );
    }
  }
  return entries;
}

function sameSnapshot(
  before: Map<string, string>,
  after: Map<string, string>,
  label: string,
) {
  const changed = [
    ...[...before].filter(([key, value]) => after.get(key) !== value).map((
      [key],
    ) => `changed or removed: ${key}`),
    ...[...after.keys()].filter((key) => !before.has(key)).map((key) =>
      `added: ${key}`
    ),
  ];
  assert(changed.length === 0, `${label}: ${changed.join(", ")}`);
}

/** Create a symlink through bash: path-scoped Deno grants cannot create links. */
async function symlink(target: string, path: string) {
  success(await run(["bash", "-c", 'ln -s -- "$1" "$2"', "_", target, path]));
}

async function writeExecutable(path: string, content: string) {
  await Deno.writeTextFile(path, content);
  await Deno.chmod(path, 0o755);
}

/** Replace every occurrence of a same-length byte string inside a message. */
function replaceBytes(
  message: Uint8Array,
  from: string,
  to: string,
): Uint8Array {
  const source = bytes.encode(from);
  const target = bytes.encode(to);
  assert(source.length === target.length, "replacement must keep its length");
  const edited = message.slice();
  let count = 0;
  for (let index = 0; index + source.length <= edited.length; index++) {
    if (source.every((byte, offset) => edited[index + offset] === byte)) {
      edited.set(target, index);
      count++;
      index += source.length - 1;
    }
  }
  assert(count > 0, `no occurrence of ${from} to replace`);
  return edited;
}

// Minimal Wasm encoder for two probe commands: an infinite loop and a module
// that grows memory until the engine refuses, prints the page count, and
// exits 3. Both are built here so the test needs no extra toolchain.
function uleb(value: number): number[] {
  const out: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
  return out;
}

function sleb(value: number): number[] {
  const out: number[] = [];
  for (;;) {
    const byte = value & 0x7f;
    value >>= 7;
    const done = (value === 0 && (byte & 0x40) === 0) ||
      (value === -1 && (byte & 0x40) !== 0);
    out.push(done ? byte : byte | 0x80);
    if (done) return out;
  }
}

function name(value: string): number[] {
  const encoded = [...bytes.encode(value)];
  return [...uleb(encoded.length), ...encoded];
}

function section(id: number, body: number[]): number[] {
  return [id, ...uleb(body.length), ...body];
}

function vector(items: number[][]): number[] {
  return [...uleb(items.length), ...items.flat()];
}

function wasmModule(sections: number[][]): Uint8Array {
  return new Uint8Array([
    0,
    0x61,
    0x73,
    0x6d,
    1,
    0,
    0,
    0,
    ...sections.flat(),
  ]);
}

const I32 = 0x7f;
const op = {
  loop: [0x03, 0x40],
  if: [0x04, 0x40],
  end: [0x0b],
  br: (depth: number) => [0x0c, ...uleb(depth)],
  brIf: (depth: number) => [0x0d, ...uleb(depth)],
  call: (index: number) => [0x10, ...uleb(index)],
  drop: [0x1a],
  localGet: (index: number) => [0x20, ...uleb(index)],
  localSet: (index: number) => [0x21, ...uleb(index)],
  i32Store: [0x36, 0x02, 0x00],
  i32Store8: [0x3a, 0x00, 0x00],
  memorySize: [0x3f, 0x00],
  memoryGrow: [0x40, 0x00],
  i32Const: (value: number) => [0x41, ...sleb(value)],
  i32Ne: [0x47],
  i32Add: [0x6a],
  i32Sub: [0x6b],
  i32DivU: [0x6e],
  i32RemU: [0x70],
};

function body(locals: number[], code: number[]): number[] {
  const content = [
    ...vector(locals.map((count) => [...uleb(count), I32])),
    ...code,
    ...op.end,
  ];
  return [...uleb(content.length), ...content];
}

const loopModule = wasmModule([
  section(1, vector([[0x60, 0, 0]])),
  section(3, vector([[0]])),
  section(5, vector([[0, 1]])),
  section(7, vector([[...name("memory"), 2, 0], [...name("_start"), 0, 0]])),
  section(10, vector([body([], [...op.loop, ...op.br(0), ...op.end])])),
]);

const growModule = wasmModule([
  section(
    1,
    vector([
      [0x60, 4, I32, I32, I32, I32, 1, I32],
      [0x60, 1, I32, 0],
      [0x60, 0, 0],
    ]),
  ),
  section(
    2,
    vector([
      [...name("wasi_snapshot_preview1"), ...name("fd_write"), 0, 0],
      [...name("wasi_snapshot_preview1"), ...name("proc_exit"), 0, 1],
    ]),
  ),
  section(3, vector([[2], [1]])),
  section(5, vector([[0, 1]])),
  section(7, vector([[...name("memory"), 2, 0], [...name("_start"), 0, 2]])),
  section(
    10,
    vector([
      body([1], [
        ...op.loop,
        ...op.i32Const(16),
        ...op.memoryGrow,
        ...op.i32Const(-1),
        ...op.i32Ne,
        ...op.if,
        ...op.br(1),
        ...op.end,
        ...op.end,
        ...op.memorySize,
        ...op.localSet(0),
        ...op.i32Const(64),
        ...op.i32Const(80),
        ...op.i32Store,
        ...op.i32Const(68),
        ...op.i32Const(0),
        ...op.i32Store,
        ...op.localGet(0),
        ...op.call(3),
        ...op.i32Const(1),
        ...op.i32Const(64),
        ...op.i32Const(1),
        ...op.i32Const(96),
        ...op.call(0),
        ...op.drop,
        ...op.i32Const(3),
        ...op.call(1),
      ]),
      // format(n): decimal digits plus newline at address 80, length at 68.
      body([2], [
        ...op.localGet(0),
        ...op.localSet(2),
        ...op.i32Const(0),
        ...op.localSet(1),
        ...op.loop,
        ...op.localGet(1),
        ...op.i32Const(1),
        ...op.i32Add,
        ...op.localSet(1),
        ...op.localGet(2),
        ...op.i32Const(10),
        ...op.i32DivU,
        ...op.localSet(2),
        ...op.localGet(2),
        ...op.i32Const(0),
        ...op.i32Ne,
        ...op.brIf(0),
        ...op.end,
        ...op.i32Const(80),
        ...op.localGet(1),
        ...op.i32Add,
        ...op.i32Const(10),
        ...op.i32Store8,
        ...op.i32Const(68),
        ...op.localGet(1),
        ...op.i32Const(1),
        ...op.i32Add,
        ...op.i32Store,
        ...op.localGet(0),
        ...op.localSet(2),
        ...op.loop,
        ...op.localGet(1),
        ...op.i32Const(1),
        ...op.i32Sub,
        ...op.localSet(1),
        ...op.i32Const(80),
        ...op.localGet(1),
        ...op.i32Add,
        ...op.i32Const(48),
        ...op.localGet(2),
        ...op.i32Const(10),
        ...op.i32RemU,
        ...op.i32Add,
        ...op.i32Store8,
        ...op.localGet(2),
        ...op.i32Const(10),
        ...op.i32DivU,
        ...op.localSet(2),
        ...op.localGet(2),
        ...op.i32Const(0),
        ...op.i32Ne,
        ...op.brIf(0),
        ...op.end,
      ]),
    ]),
  ),
]);

// A command that creates the relative symlink `rel -> a.txt` in guest `/`
// through path_symlink on the preopened directory (fd 3) and exits 0.
const symlinkModule = wasmModule([
  section(
    1,
    vector([[0x60, 5, I32, I32, I32, I32, I32, 1, I32], [0x60, 0, 0]]),
  ),
  section(
    2,
    vector([
      [...name("wasi_snapshot_preview1"), ...name("path_symlink"), 0, 0],
    ]),
  ),
  section(3, vector([[1]])),
  section(5, vector([[0, 1]])),
  section(7, vector([[...name("memory"), 2, 0], [...name("_start"), 0, 1]])),
  section(
    10,
    vector([
      body([], [
        ...op.i32Const(0),
        ...op.i32Const(5),
        ...op.i32Const(3),
        ...op.i32Const(16),
        ...op.i32Const(3),
        ...op.call(0),
        ...op.drop,
      ]),
    ]),
  ),
  section(
    11,
    vector([
      [0, ...op.i32Const(0), ...op.end, ...name("a.txt")],
      [0, ...op.i32Const(16), ...op.end, ...name("rel")],
    ]),
  ),
]);

/** A schema whose constants reference each other in a chain `depth` long. */
function constantChain(depth: number, id: string): string {
  const lines = [`@0x${id};`];
  for (let index = 0; index < depth; index++) {
    lines.push(`const c${index} :UInt32 = .c${index + 1};`);
  }
  lines.push(`const c${depth} :UInt32 = 1;`);
  return lines.join("\n") + "\n";
}

interface Context {
  temporary: string;
  pkg: string;
  launcherPath: string;
  launcher: string[];
  compiler: string[];
  direct: string[];
  workspace: string;
  generatorPackage: string;
  wasmtimePin: string;
}

const SCHEMA_ARGS = [
  "--no-standard-import",
  "-I/include",
  "/schema with spaces.capnp",
];
const COMPILE_ARGS = ["compile", "--src-prefix=/", "-o-", ...SCHEMA_ARGS];

async function checkSelfLocation(context: Context) {
  const { temporary, pkg, launcherPath } = context;
  const info = await Deno.stat(launcherPath);
  assert(
    ((info.mode ?? 0) & 0o111) !== 0,
    "packaged launcher is not executable",
  );
  const packageJson = JSON.parse(
    await Deno.readTextFile(`${pkg}/package.json`),
  );
  assert(
    packageJson.bin?.["capnp-wasm"] === "./bin/capnp-wasm",
    "package.json bin does not point at the launcher",
  );
  const version = ["compiler", "--", "--version"];
  const expectVersion = (output: Deno.CommandOutput, label: string) => {
    assert(
      output.success &&
        text.decode(output.stdout).startsWith("Cap'n Proto version"),
      `${label}: ${text.decode(output.stderr)}`,
    );
  };
  expectVersion(
    await run(["bash", "bin/capnp-wasm", ...version], {
      cwd: pkg,
      env: { CDPATH: `${temporary}:.` },
    }),
    "launcher with CDPATH set",
  );
  expectVersion(
    await run(["bash", "capnp-wasm", ...version], { cwd: `${pkg}/bin` }),
    "bare launcher name from inside bin/",
  );
  expectVersion(
    await run(["bash", "-c", 'exec "$0" "$@"', launcherPath, ...version]),
    "direct execution through the shebang",
  );
  const linkDirectory = `${temporary}/link dir`;
  const chainDirectory = `${temporary}/chain dir`;
  await Deno.mkdir(linkDirectory);
  await Deno.mkdir(chainDirectory);
  await symlink(launcherPath, `${linkDirectory}/capnp-wasm`);
  await symlink(
    "../link dir/capnp-wasm",
    `${chainDirectory}/capnp-wasm`,
  );
  expectVersion(
    await run([
      "bash",
      "-c",
      'PATH="$1:$PATH"; shift; exec capnp-wasm "$@"',
      "_",
      linkDirectory,
      ...version,
    ]),
    "symlink on PATH",
  );
  expectVersion(
    await run(["bash", `${chainDirectory}/capnp-wasm`, ...version]),
    "relative symlink chain",
  );
}

async function checkCliContract(context: Context) {
  const { temporary, pkg, launcher, compiler, workspace, wasmtimePin } =
    context;
  const help = await run([...launcher, "--help"]);
  assert(
    help.success && text.decode(help.stdout).includes("exit status"),
    "--help failed",
  );
  const version = await run([...launcher, "--version"]);
  const packageVersion = JSON.parse(
    await Deno.readTextFile(`${pkg}/package.json`),
  ).version;
  assert(
    version.success &&
      text.decode(version.stdout) ===
        `capnp-wasm ${packageVersion}\nwasmtime ${wasmtimePin}\n`,
    `--version output: ${text.decode(version.stdout)}`,
  );
  const output = `${temporary}/cli output`;
  await Deno.mkdir(output);
  await Deno.writeTextFile(`${temporary}/not a module.wasm`, "not wasm\n");
  await Deno.writeFile(
    `${temporary}/corrupt.wasm`,
    new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0xff, 0xff]),
  );
  const generator = `${context.generatorPackage}/wasm/capnpc-c++.wasm`;
  const usage: [string[], number][] = [
    [[], 64],
    [["build"], 64],
    [["compiler", "--workspace", workspace, "--version"], 64],
    [
      ["compiler", "--workspace", workspace, "--dir", "/", "--", "--version"],
      64,
    ],
    [[
      "compiler",
      "--workspace",
      workspace,
      "--workspace",
      workspace,
      "--",
      "id",
    ], 64],
    [["compiler", "--workspace", workspace, "--"], 64],
    [["compiler", "--workspace", "relative", "--", "--version"], 64],
    [
      ["compiler", "--workspace", `${workspace}::/escape`, "--", "--version"],
      64,
    ],
    [["compiler", "--workspace", "/", "--", "--version"], 64],
    [
      ["compiler", "--workspace", `${workspace}/missing`, "--", "--version"],
      66,
    ],
    [["generator", "--module", generator, "--"], 64],
    [["generator", "--module", "relative.wasm", "--output", output, "--"], 64],
    [[
      "generator",
      "--module",
      `${temporary}/missing.wasm`,
      "--output",
      output,
      "--",
    ], 66],
    [[
      "generator",
      "--module",
      `${temporary}/not a module.wasm`,
      "--output",
      output,
      "--",
    ], 65],
    [[
      "generator",
      "--module",
      generator,
      "--output",
      `${temporary}/missing`,
      "--",
    ], 66],
    [["generator", "--module", generator, "--output", "/", "--"], 64],
  ];
  for (const [args, code] of usage) {
    exitCode(await run([...launcher, ...args]), code, JSON.stringify(args));
  }
  const readOnly = `${temporary}/read-only output`;
  await Deno.mkdir(readOnly);
  await Deno.chmod(readOnly, 0o555);
  let privileged = false;
  try {
    await Deno.writeTextFile(`${readOnly}/probe`, "");
    privileged = true;
    await Deno.remove(`${readOnly}/probe`);
  } catch {
    // The directory is read-only for this user, as expected.
  }
  if (!privileged) {
    exitCode(
      await run([
        ...launcher,
        "generator",
        "--module",
        generator,
        "--output",
        readOnly,
        "--",
      ]),
      73,
      "read-only output directory",
    );
  }
  await Deno.chmod(readOnly, 0o755);
  exitCode(
    await run([
      ...launcher,
      "generator",
      "--module",
      `${temporary}/corrupt.wasm`,
      "--output",
      output,
      "--",
    ], { input: new Uint8Array(8) }),
    1,
    "corrupt module reaches Wasmtime and fails to load",
  );
  for (
    const [env, code] of [
      [{ CAPNP_WASM_TIMEOUT: "1.5" }, 78],
      [{ CAPNP_WASM_TIMEOUT: "-1" }, 78],
      [{ CAPNP_WASM_MAX_MEMORY: "1" }, 78],
      [{ CAPNP_WASM_MAX_MEMORY: "256M" }, 78],
      [{ CAPNP_WASM_MAX_WORKSPACE: "0" }, 78],
      [{ CAPNP_WASM_WASMTIME_ACCEPT_VERSION: "latest" }, 78],
      [{ CAPNP_WASM_WASMTIME: `${temporary}/missing runtime` }, 69],
    ] as [Record<string, string>, number][]
  ) {
    exitCode(
      await run([...compiler, "--version"], { env }),
      code,
      JSON.stringify(env),
    );
  }
  // Runtime version policy: the packaged version, a newer patch release of the
  // same series (with a warning), or one explicitly accepted version.
  const [major, minor, patch] = wasmtimePin.split(".").map(Number);
  const fakeRuntime = async (reported: string) => {
    const path = `${temporary}/runtime ${reported}`;
    await writeExecutable(
      path,
      `#!/bin/sh\nif [ "$1" = --version ]; then printf 'wasmtime ${reported} (fake)\\n'; exit 0; fi\nexec wasmtime "$@"\n`,
    );
    return path;
  };
  const wrapper = `${temporary}/runtime with spaces`;
  await writeExecutable(wrapper, '#!/bin/sh\nexec wasmtime "$@"\n');
  success(
    await run([...compiler, "--version"], {
      env: { CAPNP_WASM_WASMTIME: wrapper },
    }),
  );
  // A relative CAPNP_WASM_WASMTIME resolves against the caller's directory,
  // although the guest runs from the module's directory.
  success(
    await run([...compiler, "--version"], {
      cwd: temporary,
      env: { CAPNP_WASM_WASMTIME: "./runtime with spaces" },
    }),
  );
  const newerPatch = await run([...compiler, "--version"], {
    env: {
      CAPNP_WASM_WASMTIME: await fakeRuntime(`${major}.${minor}.${patch + 1}`),
    },
  });
  assert(
    newerPatch.success && stderrOf(newerPatch).includes("newer patch release"),
    `newer patch release rejected or silent: ${stderrOf(newerPatch)}`,
  );
  for (
    const reported of [
      "0.0.0",
      `${major}.${minor + 1}.0`,
      `${major + 1}.0.0`,
      ...(patch > 0 ? [`${major}.${minor}.${patch - 1}`] : []),
    ]
  ) {
    const rejected = await run([...compiler, "--version"], {
      env: { CAPNP_WASM_WASMTIME: await fakeRuntime(reported) },
    });
    assert(
      rejected.code === 78 && stderrOf(rejected).includes("expected Wasmtime"),
      `Wasmtime ${reported} accepted: ${stderrOf(rejected)}`,
    );
  }
  const nextMajor = `${major + 1}.0.0`;
  const accepted = await run([...compiler, "--version"], {
    env: {
      CAPNP_WASM_WASMTIME: await fakeRuntime(nextMajor),
      CAPNP_WASM_WASMTIME_ACCEPT_VERSION: nextMajor,
    },
  });
  assert(
    accepted.success && stderrOf(accepted).includes("instead of the packaged"),
    `accepted Wasmtime ${nextMajor} rejected: ${stderrOf(accepted)}`,
  );
  exitCode(
    await run([...compiler, "--version"], {
      env: {
        CAPNP_WASM_WASMTIME: await fakeRuntime(nextMajor),
        CAPNP_WASM_WASMTIME_ACCEPT_VERSION: `${major + 1}.0.1`,
      },
    }),
    78,
    "accepted version that differs from the installed one",
  );
}

async function checkBounds(context: Context) {
  const { temporary, launcher, compiler, workspace } = context;
  const modules = `${temporary}/probe modules`;
  const output = `${temporary}/probe output`;
  await Deno.mkdir(modules);
  await Deno.mkdir(output);
  await Deno.writeFile(`${modules}/loop.wasm`, loopModule);
  await Deno.writeFile(`${modules}/grow.wasm`, growModule);
  const generator = (module: string, env?: Record<string, string>) =>
    run([
      ...launcher,
      "generator",
      "--module",
      `${modules}/${module}`,
      "--output",
      output,
      "--",
    ], { env, timeoutMs: 30_000 });
  const started = performance.now();
  const timedOut = await generator("loop.wasm", { CAPNP_WASM_TIMEOUT: "1" });
  assert(
    timedOut.code === 134 &&
      stderrOf(timedOut).includes("wasm trap: interrupt"),
    `timeout did not trap: ${timedOut.code} ${stderrOf(timedOut)}`,
  );
  assert(
    performance.now() - started < 15_000,
    "timeout took longer than expected",
  );
  assert(
    !stderrOf(timedOut).includes(temporary),
    "trap output leaks the host module path",
  );
  const pages = async (env?: Record<string, string>) => {
    const grown = await generator("grow.wasm", env);
    assert(grown.code === 3, `memory probe: ${grown.code} ${stderrOf(grown)}`);
    return Number(text.decode(grown.stdout).trim());
  };
  // The probe starts with one page and grows 16 pages at a time.
  assert(
    (await pages()) === 4081,
    "default memory ceiling is not 256 MiB",
  );
  assert(
    (await pages({ CAPNP_WASM_MAX_MEMORY: "33554432" })) === 497,
    "CAPNP_WASM_MAX_MEMORY override was not applied",
  );
  // Compiler recursion: depth 200 fails with Wasmtime's default stack and must
  // compile here; a far deeper chain traps cleanly with a bounded backtrace.
  await Deno.writeTextFile(
    `${workspace}/chain200.capnp`,
    constantChain(200, "c0000000000000c8"),
  );
  await Deno.writeTextFile(
    `${workspace}/chain6000.capnp`,
    constantChain(6000, "c000000000001770"),
  );
  assert(
    success(
      await run([
        ...compiler,
        "compile",
        "--no-standard-import",
        "-o-",
        "/chain200.capnp",
      ]),
    ).length > 0,
    "depth-200 constant chain produced no request",
  );
  const exhausted = await run([
    ...compiler,
    "compile",
    "--no-standard-import",
    "-o-",
    "/chain6000.capnp",
  ], { timeoutMs: 120_000 });
  const trap = stderrOf(exhausted);
  assert(
    exhausted.code === 134 && trap.includes("wasm trap") &&
      !trap.includes(temporary) &&
      (trap.match(/capnp\.wasm!/g) ?? []).length <= 16,
    `deep chain did not trap with a bounded backtrace: ${exhausted.code} ${
      trap.slice(0, 400)
    }`,
  );
  await Deno.remove(`${workspace}/chain200.capnp`);
  await Deno.remove(`${workspace}/chain6000.capnp`);
  // Stopping the launcher stops the guest and removes the staging directory.
  const stop = new Deno.Command("bash", {
    args: [
      ...launcher.slice(1),
      "generator",
      "--module",
      `${modules}/loop.wasm`,
      "--output",
      output,
      "--",
    ],
    env: { CAPNP_WASM_TIMEOUT: "0" },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  stop.kill("SIGTERM");
  const stopped = await Promise.race([
    stop.output(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
  ]);
  assert(
    stopped !== null,
    "guest kept the standard streams open after the launcher was stopped",
  );
  assert(
    !stopped.success && (stopped.signal === "SIGTERM" || stopped.code === 143),
    `stopped launcher status: ${stopped.code} ${stopped.signal}`,
  );
  const leftovers = [...await snapshot(temporary)].filter(([path]) =>
    path.includes(".capnp-wasm.")
  );
  assert(leftovers.length === 0, `staging left behind: ${leftovers}`);
}

async function checkArgv0(context: Context) {
  const { launcher, compiler, generatorPackage } = context;
  const bogus = await run([...compiler, "compile", "--bogus"]);
  const diagnostics = stderrOf(bogus);
  assert(
    bogus.code === 1 && diagnostics.includes("capnp compile: --bogus") &&
      diagnostics.includes("Try 'capnp compile --help'"),
    `compiler argv[0] is not capnp: ${diagnostics}`,
  );
  const help = await run([
    ...launcher,
    "generator",
    "--module",
    `${generatorPackage}/wasm/capnpc-c++.wasm`,
    "--output",
    context.temporary,
    "--",
    "--help",
  ]);
  const usage = text.decode(help.stdout) + stderrOf(help);
  assert(
    usage.includes("capnpc-c++") && !usage.includes("capnpc-c++.wasm"),
    `generator argv[0] is not the module basename: ${usage.slice(0, 200)}`,
  );
}

async function checkCompilerSemantics(context: Context, request: Uint8Array) {
  const { temporary, launcher, compiler, direct, workspace } = context;
  // The workspace is byte-identical after successful, converting, and failing
  // runs, and the guest never sees the original directory.
  const before = await snapshot(workspace);
  equal(
    success(await run([...compiler, ...COMPILE_ARGS])),
    request,
    "repeated compile",
  );
  const encoded = success(
    await run([...compiler, "encode", ...SCHEMA_ARGS, "Candidate"], {
      input: bytes.encode('(value = 0x"000102ff0080")'),
    }),
  );
  const canonical = success(
    await run([...compiler, "convert", "binary:canonical"], { input: encoded }),
  );
  equal(
    canonical,
    success(
      await run([...direct, "convert", "binary:canonical"], { input: encoded }),
    ),
    "binary canonicalization",
  );
  equal(
    canonical,
    success(
      await run([...compiler, "convert", "flat:canonical"], {
        input: canonical,
      }),
    ),
    "canonical idempotence",
  );
  await Deno.writeTextFile(`${workspace}/bad.capnp`, "invalid schema");
  const invalidArgs = ["compile", "-o-", "/bad.capnp"];
  const invalid = await run([...compiler, ...invalidArgs]);
  const invalidDirect = await run([...direct, ...invalidArgs]);
  assert(
    !invalid.success && invalid.code === invalidDirect.code &&
      invalid.stderr.length > 0,
    "invalid schema status/diagnostics were lost",
  );
  await Deno.remove(`${workspace}/bad.capnp`);
  sameSnapshot(
    before,
    await snapshot(workspace),
    "workspace after compiler runs",
  );
  // Without --workspace the guest sees an empty root.
  const bare = [...launcher, "compiler", "--"];
  equal(
    success(
      await run([...bare, "convert", "binary:canonical"], { input: encoded }),
    ),
    canonical,
    "conversion without a workspace",
  );
  assert(
    text.decode(success(await run([...bare, "id"]))).startsWith("@0x"),
    "id without a workspace",
  );
  success(await run([...bare, "--version"]));
  // Home-directory and oversized workspaces.
  const home = await run([...compiler, "--version"], {
    env: { HOME: workspace },
  });
  assert(
    home.success && stderrOf(home).includes("home directory"),
    `no warning for a home-directory workspace: ${stderrOf(home)}`,
  );
  const large = `${temporary}/large workspace`;
  await Deno.mkdir(large);
  await Deno.writeFile(`${large}/blob`, new Uint8Array(64 * 1024));
  exitCode(
    await run([
      ...launcher,
      "compiler",
      "--workspace",
      large,
      "--",
      "--version",
    ], {
      env: { CAPNP_WASM_MAX_WORKSPACE: "4096" },
    }),
    73,
    "workspace over CAPNP_WASM_MAX_WORKSPACE",
  );
  // More than 65536 entries is refused with the hint even though head cuts
  // find short (its SIGPIPE must not trip the launcher's pipefail).
  const crowded = `${temporary}/crowded workspace`;
  await Deno.mkdir(crowded);
  success(
    await run([
      "bash",
      "-c",
      'cd "$1" && seq 1 65537 | sed "s/^/f/" | xargs touch',
      "_",
      crowded,
    ]),
  );
  const tooMany = await run([
    ...launcher,
    "compiler",
    "--workspace",
    crowded,
    "--",
    "--version",
  ]);
  assert(
    tooMany.code === 73 &&
      stderrOf(tooMany).includes("more than 65536 entries") &&
      stderrOf(tooMany).includes("point --workspace"),
    `crowded workspace: ${tooMany.code} ${stderrOf(tooMany)}`,
  );
  success(await run(["bash", "-c", 'rm -rf -- "$1"', "_", crowded]));
  // An unreadable subdirectory fails the copy with exit 73 and a message, and
  // leaves nothing behind in TMPDIR.
  const shielded = `${temporary}/shielded workspace`;
  const scratch = `${temporary}/scratch tmpdir`;
  await Deno.mkdir(`${shielded}/private`, { recursive: true });
  await Deno.mkdir(scratch);
  await Deno.writeTextFile(`${shielded}/private/x.capnp`, "");
  await Deno.chmod(`${shielded}/private`, 0o000);
  try {
    let privileged = true;
    try {
      for await (const _entry of Deno.readDir(`${shielded}/private`)) {
        // Readable despite mode 000: running as root.
      }
    } catch {
      privileged = false;
    }
    const unreadable = await run([
      ...launcher,
      "compiler",
      "--workspace",
      shielded,
      "--",
      "--version",
    ], { env: { TMPDIR: scratch } });
    if (!privileged) {
      assert(
        unreadable.code === 73 &&
          stderrOf(unreadable).includes("cannot copy the workspace"),
        `unreadable subdirectory: ${unreadable.code} ${stderrOf(unreadable)}`,
      );
    }
    assert(
      (await snapshot(scratch)).size === 0,
      "staging left behind in TMPDIR after a failed workspace copy",
    );
  } finally {
    await Deno.chmod(`${shielded}/private`, 0o755);
  }
}

async function checkCompilerConfinement(context: Context) {
  const { temporary, compiler, workspace } = context;
  const outside = `${temporary}/outside`;
  await Deno.mkdir(`${outside}/schemas`, { recursive: true });
  await Deno.writeTextFile(`${outside}/secret.txt`, "outside the workspace\n");
  await Deno.writeTextFile(
    `${outside}/schemas/leak.capnp`,
    "@0xd4c8e13f8c0b2a11; struct Leak { value @0 :UInt8; }\n",
  );
  await Deno.writeTextFile(`${workspace}/inside.txt`, "inside\n");
  await symlink("inside.txt", `${workspace}/inside link`);
  await symlink(`${outside}/secret.txt`, `${workspace}/absolute link`);
  await symlink("../outside/secret.txt", `${workspace}/relative escape`);
  await symlink(`${outside}/schemas`, `${workspace}/escaped schemas`);
  const before = await snapshot(temporary);
  const compile = (schema: string) =>
    run([...compiler, "compile", "--no-standard-import", "-o-", schema]);
  await Deno.writeTextFile(
    `${workspace}/ok.capnp`,
    '@0xd4c8e13f8c0b2a12; const inside :Data = embed "inside link";\n',
  );
  const ok = await compile("/ok.capnp");
  assert(
    ok.success && ok.stdout.length > 0 &&
      stderrOf(ok).includes("symlink leaves the workspace") &&
      stderrOf(ok).includes("absolute link") &&
      stderrOf(ok).includes("relative escape") &&
      !stderrOf(ok).includes("inside link"),
    `relative symlink inside the workspace failed or warnings are wrong: ${
      stderrOf(ok)
    }`,
  );
  const escapes: [string, string][] = [
    ["absolute link.capnp", 'const v :Data = embed "absolute link";'],
    ["relative escape.capnp", 'const v :Data = embed "relative escape";'],
    ["dotdot.capnp", 'const v :Data = embed "../outside/secret.txt";'],
    ["import escape.capnp", 'using L = import "escaped schemas/leak.capnp";'],
    [
      "import dotdot.capnp",
      'using L = import "../outside/schemas/leak.capnp";',
    ],
  ];
  for (const [file, declaration] of escapes) {
    await Deno.writeTextFile(
      `${workspace}/${file}`,
      `@0xd4c8e13f8c0b2a13; ${declaration}\n`,
    );
    const escaped = await compile(`/${file}`);
    assert(
      !escaped.success && escaped.stdout.length === 0 &&
        !stderrOf(escaped).includes("outside the workspace"),
      `escape through ${file} was not refused: ${escaped.code} ${
        stderrOf(escaped)
      }`,
    );
    await Deno.remove(`${workspace}/${file}`);
  }
  await Deno.remove(`${workspace}/ok.capnp`);
  sameSnapshot(before, await snapshot(temporary), "after confinement runs");
  for (
    const entry of [
      "inside.txt",
      "inside link",
      "absolute link",
      "relative escape",
      "escaped schemas",
    ]
  ) await Deno.remove(`${workspace}/${entry}`);
}

async function checkGeneratorSemantics(context: Context) {
  const { temporary, launcher, generatorPackage } = context;
  const module = `${generatorPackage}/wasm/capnpc-c++.wasm`;
  const generate = (output: string, request: Uint8Array) =>
    run([
      ...launcher,
      "generator",
      "--module",
      module,
      "--output",
      output,
      "--",
    ], { input: request });
  const staged = `${temporary}/staged workspace`;
  await Deno.mkdir(`${staged}/sub`, { recursive: true });
  await Deno.writeTextFile(
    `${staged}/first.capnp`,
    "@0xd4c8e13f8c0b2a21; struct First { value @0 :UInt8; }\n",
  );
  await Deno.writeTextFile(
    `${staged}/seco.capnp`,
    "@0xd4c8e13f8c0b2a22; struct Seco { value @0 :UInt8; }\n",
  );
  await Deno.writeTextFile(
    `${staged}/sub/seco.capnp`,
    "@0xd4c8e13f8c0b2a23; struct Nested { value @0 :UInt8; }\n",
  );
  const stagedCompiler = [...launcher, "compiler", "--workspace", staged, "--"];
  const twoFiles = success(
    await run([
      ...stagedCompiler,
      "compile",
      "--no-standard-import",
      "--src-prefix=/",
      "-o-",
      "/first.capnp",
      "/seco.capnp",
    ]),
  );
  const nested = success(
    await run([
      ...stagedCompiler,
      "compile",
      "--no-standard-import",
      "--src-prefix=/",
      "-o-",
      "/sub/seco.capnp",
    ]),
  );
  // Success publishes every file, including new directories, and leaves no
  // staging directory behind.
  const fresh = `${temporary}/fresh output`;
  await Deno.mkdir(fresh);
  success(await generate(fresh, twoFiles));
  success(await generate(fresh, nested));
  const published = [...(await snapshot(fresh)).keys()].sort();
  assert(
    JSON.stringify(published) === JSON.stringify([
      "first.capnp.c++",
      "first.capnp.h",
      "seco.capnp.c++",
      "seco.capnp.h",
      "sub",
      "sub/seco.capnp.c++",
      "sub/seco.capnp.h",
    ]),
    `published files: ${published}`,
  );
  // Re-running replaces existing files and keeps the tree identical.
  const firstRun = await snapshot(fresh);
  success(await generate(fresh, twoFiles));
  sameSnapshot(firstRun, await snapshot(fresh), "regeneration");
  // A failed run leaves the output directory byte-identical.
  await Deno.mkdir(`${temporary}/outside`, { recursive: true });
  await Deno.mkdir(`${temporary}/outside/dir`);
  const conflicts: [string, (output: string) => Promise<void>, number][] = [
    ["directory conflict", async (output) => {
      await Deno.mkdir(`${output}/seco.capnp.h`);
      await Deno.writeTextFile(`${output}/first.capnp.h`, "OLD first\n");
    }, 73],
    ["read-only file", async (output) => {
      await Deno.writeTextFile(`${output}/seco.capnp.h`, "OLD seco\n");
      await Deno.chmod(`${output}/seco.capnp.h`, 0o444);
    }, 73],
    ["file symlink", async (output) => {
      await symlink(
        `${temporary}/outside/target.h`,
        `${output}/seco.capnp.h`,
      );
    }, 73],
  ];
  for (const [label, plant, code] of conflicts) {
    const output = `${temporary}/${label} output`;
    await Deno.mkdir(output);
    await plant(output);
    const before = await snapshot(temporary);
    exitCode(await generate(output, twoFiles), code, label);
    sameSnapshot(before, await snapshot(temporary), label);
  }
  const symlinkedParent = `${temporary}/parent symlink output`;
  await Deno.mkdir(symlinkedParent);
  await symlink(`${temporary}/outside/dir`, `${symlinkedParent}/sub`);
  const beforeParent = await snapshot(temporary);
  exitCode(await generate(symlinkedParent, nested), 73, "symlinked parent");
  sameSnapshot(beforeParent, await snapshot(temporary), "symlinked parent");
  // A module whose name starts with a dash is not taken for a Wasmtime option,
  // and the guest still sees that name as argv[0].
  const dashed = `${temporary}/-dashed.wasm`;
  await Deno.copyFile(module, dashed);
  const dashOutput = `${temporary}/dash output`;
  await Deno.mkdir(dashOutput);
  success(
    await run([
      ...launcher,
      "generator",
      "--module",
      dashed,
      "--output",
      dashOutput,
      "--",
    ], { input: twoFiles }),
  );
  assert(
    (await snapshot(dashOutput)).has("first.capnp.h"),
    "dashed module produced no output",
  );
  const dashHelp = await run([
    ...launcher,
    "generator",
    "--module",
    dashed,
    "--output",
    dashOutput,
    "--",
    "--help",
  ]);
  assert(
    (text.decode(dashHelp.stdout) + stderrOf(dashHelp)).includes("-dashed"),
    `dashed module argv[0]: ${stderrOf(dashHelp)}`,
  );
  // A symlink created by the guest is refused before anything is published.
  const linkModule = `${temporary}/symlink module/symlink.wasm`;
  await Deno.mkdir(`${temporary}/symlink module`);
  await Deno.writeFile(linkModule, symlinkModule);
  const linkOutput = `${temporary}/symlink output`;
  await Deno.mkdir(linkOutput);
  const beforeLink = await snapshot(temporary);
  const linked = await run([
    ...launcher,
    "generator",
    "--module",
    linkModule,
    "--output",
    linkOutput,
    "--",
  ]);
  assert(
    linked.code === 73 &&
      stderrOf(linked).includes("generator produced a symlink"),
    `guest-created symlink: ${linked.code} ${stderrOf(linked)}`,
  );
  sameSnapshot(beforeLink, await snapshot(temporary), "guest-created symlink");
  // When a move fails part-way, the staged output is kept and named, and every
  // generated file is in exactly one of the two places.
  const fakeBin = `${temporary}/fake bin`;
  await Deno.mkdir(fakeBin);
  await writeExecutable(
    `${fakeBin}/mv`,
    '#!/bin/sh\nfor arg; do case $arg in *seco.capnp.h) echo "mv: simulated failure: $arg" >&2; exit 1;; esac; done\nPATH=${PATH#*:}\nexec mv "$@"\n',
  );
  const partial = `${temporary}/partial output`;
  await Deno.mkdir(partial);
  const interrupted = await run([
    "bash",
    "-c",
    'PATH="$1:$PATH"; shift; exec "$@"',
    "_",
    fakeBin,
    context.launcherPath,
    "generator",
    "--module",
    module,
    "--output",
    partial,
    "--",
  ], { input: twoFiles });
  const kept = /unpublished output kept in (.+)$/m.exec(
    stderrOf(interrupted),
  )?.[1];
  assert(
    interrupted.code === 73 && kept !== undefined,
    `failed move: ${interrupted.code} ${stderrOf(interrupted)}`,
  );
  const keptTree = await snapshot(kept);
  const partialTree = await snapshot(partial);
  for (
    const file of [
      "first.capnp.c++",
      "first.capnp.h",
      "seco.capnp.c++",
      "seco.capnp.h",
    ]
  ) {
    assert(
      keptTree.has(file) !== partialTree.has(file),
      `${file} is not in exactly one of the output and the kept staging directory`,
    );
  }
  assert(
    keptTree.has("seco.capnp.h"),
    "the file whose move failed is missing from the kept staging directory",
  );
  await Deno.remove(kept, { recursive: true });
  // Requests that name files outside the root never write outside it, and a
  // partially written run publishes nothing.
  for (const escape of ["../x.capnp", "/../escape"]) {
    const output = `${temporary}/escape ${escape.replace(/[/.]/g, "_")}`;
    await Deno.mkdir(output);
    const before = await snapshot(temporary);
    const escaped = await generate(
      output,
      replaceBytes(twoFiles, "seco.capnp", escape),
    );
    assert(
      !escaped.success,
      `request naming ${escape} succeeded: ${stderrOf(escaped)}`,
    );
    sameSnapshot(before, await snapshot(temporary), `request naming ${escape}`);
  }
  // Malformed input fails without publishing anything.
  const malformedOutput = `${temporary}/malformed output`;
  await Deno.mkdir(malformedOutput);
  const beforeMalformed = await snapshot(temporary);
  assert(
    !(await generate(malformedOutput, new Uint8Array([0, 1, 2]))).success,
    "malformed generator request succeeded",
  );
  sameSnapshot(beforeMalformed, await snapshot(temporary), "malformed request");
  // The guest environment is empty: CAPNPC_ZIG_* does not change output.
  const zig = `${generatorPackage}/wasm/capnpc-zig.wasm`;
  const zigRun = async (output: string, env?: Record<string, string>) => {
    await Deno.mkdir(output);
    return await run([
      ...launcher,
      "generator",
      "--module",
      zig,
      "--output",
      output,
      "--",
    ], { input: twoFiles, env });
  };
  success(await zigRun(`${temporary}/zig plain`));
  const compact = await zigRun(`${temporary}/zig env`, {
    CAPNPC_ZIG_API_PROFILE: "compact",
  });
  assert(
    compact.success && stderrOf(compact).includes("CAPNPC_ZIG_"),
    `no warning for CAPNPC_ZIG_* in the environment: ${stderrOf(compact)}`,
  );
  const plainTree = await snapshot(`${temporary}/zig plain`);
  sameSnapshot(
    plainTree,
    await snapshot(`${temporary}/zig env`),
    "capnpc-zig output with CAPNPC_ZIG_* set",
  );
  assert(plainTree.size > 0, "capnpc-zig produced no files");
}

/** Exercise the installed launcher and real compiler/generator, outside the package. */
export async function checkLauncher(
  packagePath: string,
  generatorPackagePath = packagePath,
): Promise<void> {
  await Deno.mkdir("build/test", { recursive: true });
  const temporary = await Deno.realPath(
    await Deno.makeTempDir({
      dir: "build/test",
      prefix: "launcher with spaces ",
    }),
  );
  try {
    const pkg = `${temporary}/package with spaces`;
    for (const file of await packageFiles(packagePath)) {
      if (
        !/^(bin|runtime|wasm|include)\//.test(file) && file !== "package.json"
      ) {
        continue;
      }
      const destination = `${pkg}/${file}`;
      await Deno.mkdir(destination.slice(0, destination.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.copyFile(`${packagePath}/${file}`, destination);
    }
    const generatorPackage = await Deno.realPath(generatorPackagePath);
    const workspace = `${temporary}/input with spaces`;
    const output = `${temporary}/output with spaces`;
    const oracle = `${temporary}/direct output`;
    for (const dir of [workspace, output, oracle]) {
      await Deno.mkdir(dir);
    }
    await Deno.mkdir(`${workspace}/include/capnp`, { recursive: true });
    await Deno.copyFile(
      `${pkg}/include/capnp/c++.capnp`,
      `${workspace}/include/capnp/c++.capnp`,
    );
    await Deno.writeTextFile(
      `${workspace}/schema with spaces.capnp`,
      '@0xece4bf9c1f867623; using Cxx = import "/capnp/c++.capnp"; $Cxx.namespace("candidate"); struct Candidate { value @0 :Data; }\n',
    );
    const launcherPath = `${pkg}/bin/capnp-wasm`;
    const launcher = ["bash", launcherPath];
    const context: Context = {
      temporary,
      pkg,
      launcherPath,
      launcher,
      compiler: [...launcher, "compiler", "--workspace", workspace, "--"],
      direct: [
        "wasmtime",
        "run",
        "-W",
        "exceptions=y",
        "-S",
        "cwd=/",
        "--dir",
        `${workspace}::/`,
        "--argv0",
        "capnp",
        `${pkg}/wasm/capnp.wasm`,
      ],
      workspace,
      generatorPackage,
      wasmtimePin: (await Deno.readTextFile(`${pkg}/runtime/wasmtime-version`))
        .trim(),
    };
    await checkSelfLocation(context);
    const request = success(await run([...context.compiler, ...COMPILE_ARGS]));
    equal(
      request,
      success(await run([...context.direct, ...COMPILE_ARGS])),
      "compiler binary request",
    );
    assert(
      request.includes(0),
      "compiler request does not contain binary NULs",
    );
    for (const generator of ["capnpc-c++", "capnpc-zig"]) {
      const module = `${generatorPackage}/wasm/${generator}.wasm`;
      success(
        await run([
          ...launcher,
          "generator",
          "--module",
          module,
          "--output",
          output,
          "--",
        ], { input: request }),
      );
      success(
        await run([
          "wasmtime",
          "run",
          "-W",
          "exceptions=y",
          "-S",
          "cwd=/",
          "--dir",
          `${oracle}::/`,
          module,
        ], { input: request }),
      );
    }
    for (
      const file of [
        "schema with spaces.capnp.h",
        "schema with spaces.capnp.c++",
        "schema with spaces.zig",
      ]
    ) {
      equal(
        await Deno.readFile(`${output}/${file}`),
        await Deno.readFile(`${oracle}/${file}`),
        file,
      );
    }
    await checkCompilerSemantics(context, request);
    await checkArgv0(context);
    await checkCliContract(context);
    await checkBounds(context);
    await checkCompilerConfinement(context);
    await checkGeneratorSemantics(context);
    console.log(
      "Packaged launcher passed: self-location, CLI contract and exit codes, bounds, argv[0], read-only workspace, staged output, and confinement",
    );
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
}

if (import.meta.main) {
  const metadata = JSON.parse(await Deno.readTextFile("release.json"));
  await checkLauncher(
    Deno.args[0] ?? `dist/releases/capnpc-wasm-${metadata.version}/package`,
  );
}
