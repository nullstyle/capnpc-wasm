/**
 * In-guest interruption: the module rewriter (wasm.ts), and host stops that
 * trap instead of throwing into the guest (runtime.ts).
 */
import { CompileError, createCompiler, defaultLimits } from "./mod.ts";
import { Cancelled, countdownExport, JobControl } from "./interrupt.ts";
import { runCommand } from "./runtime.ts";
import { compileBounded, instrument } from "./wasm.ts";
import {
  catchRetryGuest,
  catchRetryMode,
  legacyExceptionsModule,
  namedTrapGuest,
  rewriterCoverageModule,
} from "./testdata/interrupt_guests.ts";
import {
  assert,
  commandGuest,
  leb,
  loopGuest,
  name,
  read,
  rejectsWith,
  section,
  simpleRequest,
  trapGuest,
} from "./testdata/support.ts";

/** Instantiate `bytes` (instrumented or not) with the coverage imports. */
async function exportsOf(
  bytes: BufferSource,
  interrupt: () => number = () => 0,
): Promise<WebAssembly.Exports> {
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: { add: (a: number, b: number) => a + b, base: 40 },
    capnp_wasm: { interrupt },
  });
  return instance.exports;
}

Deno.test("SDK instrumentation keeps every export's result across instruction families", async () => {
  for (const module of [rewriterCoverageModule, legacyExceptionsModule]) {
    const rewritten = instrument(module, 16).bytes;
    assert(WebAssembly.validate(rewritten), "instrumented module is invalid");
    const before = await exportsOf(module);
    const after = await exportsOf(rewritten);
    let compared = 0;
    for (const [key, value] of Object.entries(before)) {
      if (typeof value !== "function") continue;
      const expected = value();
      const actual = (after[key] as () => unknown)();
      assert(
        actual === expected,
        `${key}: ${String(actual)} instead of ${String(expected)}`,
      );
      compared++;
    }
    assert(compared > 0, "no exports compared");
  }
});

Deno.test("SDK instrumentation adds one import, type, global and export and renumbers calls", async () => {
  const result = instrument(rewriterCoverageModule, 16);
  // Two loops; six functions calling guest code (directly, indirectly or by
  // reference); `call $add` and `return_call $add` reach the import.
  assert(
    result.functions === 19 && result.loopChecks === 2 &&
      result.entryChecks === 6 && result.importChecks === 2,
    `unexpected checks: ${JSON.stringify({ ...result, bytes: undefined })}`,
  );
  const module = new WebAssembly.Module(result.bytes);
  const imports = WebAssembly.Module.imports(module);
  assert(
    JSON.stringify(
      imports.map(({ module, name, kind }) => [module, name, kind]),
    ) ===
      JSON.stringify([
        ["env", "add", "function"],
        ["env", "base", "global"],
        ["capnp_wasm", "interrupt", "function"],
      ]),
    `unexpected imports: ${JSON.stringify(imports)}`,
  );
  const exports = await exportsOf(result.bytes);
  const countdown = exports[countdownExport];
  assert(
    countdown instanceof WebAssembly.Global && countdown.value > 0,
    "countdown global is not exported",
  );
  // A module without imports, globals or custom sections gains all four.
  const bare = instrument(loopGuest, 16).bytes;
  const bareModule = new WebAssembly.Module(bare);
  assert(
    WebAssembly.Module.imports(bareModule).length === 1 &&
      WebAssembly.Module.exports(bareModule).some((entry) =>
        entry.name === countdownExport && entry.kind === "global"
      ),
    "sections were not synthesized",
  );
});

Deno.test("SDK instrumentation polls every interval and traps on a nonzero answer", async () => {
  // `loops` is a leaf function with one loop of 41 iterations: 41 checks.
  let polls = 0;
  const every = await exportsOf(
    instrument(rewriterCoverageModule, 16, 1).bytes,
    () => (polls++, 0),
  );
  (every.loops as () => number)();
  assert(polls === 40, `expected 40 polls at interval 1, saw ${polls}`);
  polls = 0;
  const tenth = await exportsOf(
    instrument(rewriterCoverageModule, 16, 10).bytes,
    () => (polls++, 0),
  );
  (tenth.loops as () => number)();
  assert(polls === 4, `expected 4 polls at interval 10, saw ${polls}`);
  // A trap, not an exception, so the guest's own handlers cannot catch it.
  const stopped = await exportsOf(
    instrument(rewriterCoverageModule, 16, 1).bytes,
    () => 1,
  );
  let trap: unknown;
  try {
    (stopped.loops as () => number)();
  } catch (error) {
    trap = error;
  }
  assert(trap instanceof WebAssembly.RuntimeError, `no trap: ${trap}`);
});

Deno.test("SDK instrumentation keeps function names in trap backtraces", async () => {
  const result = instrument(namedTrapGuest, 16);
  assert(result.names === "renumbered", `name section ${result.names}`);
  const compiler = await createCompiler({
    compiler: namedTrapGuest,
    generators: {},
  });
  const failure = await rejectsWith(
    () => compiler.compile({ ...simpleRequest(), generators: [] }),
    CompileError,
    "compiler trapped: WASI command failed: unreachable",
  );
  const trap = (failure.cause as Error).cause;
  assert(trap instanceof WebAssembly.RuntimeError, `no trap: ${trap}`);
  const frames = (trap.stack ?? "").split("\n").filter((line) =>
    line.includes("wasm-function")
  );
  assert(
    /\bbravo\b/.test(frames[0]) && /\bcharlie\b/.test(frames[1]),
    `backtrace names the wrong functions:\n${frames.join("\n")}`,
  );
});

/** Append a custom section to `module`. */
function withCustom(
  module: Uint8Array,
  label: string,
  payload: number[],
): Uint8Array {
  return new Uint8Array([
    ...module,
    ...section(0, [...name(label), ...payload]),
  ]);
}

Deno.test("SDK instrumentation drops custom sections it cannot keep exact", () => {
  const base = commandGuest([]);
  // Label names (subsection 3) index blocks, which the checks shift.
  const labels = instrument(
    withCustom(base, "name", [3, 1, 0]),
    16,
  );
  assert(labels.names === "dropped", `label names were ${labels.names}`);
  const truncated = instrument(withCustom(base, "name", [1, 5, 1]), 16);
  assert(truncated.names === "dropped", "malformed names were kept");
  const functions = instrument(
    withCustom(base, "name", [1, 4, 1, 1, ...name("x")]),
    16,
  );
  assert(functions.names === "renumbered", "function names were not kept");
  let module = base;
  for (
    const label of [
      "producers",
      "target_features",
      ".debug_info",
      "sourceMappingURL",
      "metadata.code.branch_hint",
      "go:buildid",
    ]
  ) module = withCustom(module, label, [0]);
  const kept = new WebAssembly.Module(instrument(module, 16).bytes);
  for (
    const [label, expected] of [
      ["producers", 1],
      ["target_features", 1],
      [".debug_info", 0],
      ["sourceMappingURL", 0],
      ["metadata.code.branch_hint", 0],
      ["go:buildid", 0],
    ] as const
  ) {
    const count = WebAssembly.Module.customSections(kept, label).length;
    assert(count === expected, `${label}: ${count} sections`);
  }
});

Deno.test("SDK instrumentation fails closed on constructs it cannot parse exactly", () => {
  const header = [0, 97, 115, 109, 1, 0, 0, 0];
  const memory = section(5, [1, 0, 1]);
  const exports = section(7, [
    2,
    ...name("memory"),
    2,
    0,
    ...name("_start"),
    0,
    0,
  ]);
  const withBody = (body: number[]) =>
    new Uint8Array([
      ...header,
      ...section(1, [1, 0x60, 0, 0]),
      ...section(3, [1, 0]),
      ...memory,
      ...exports,
      ...section(10, [1, ...leb(body.length + 2), 0, ...body, 0x0b]),
    ]);
  const cases: [string, Uint8Array, string][] = [
    ["reserved opcode", withBody([0x27]), "unsupported Wasm instruction 0x27"],
    ["GC prefix", withBody([0xfb, 0]), "unsupported Wasm instruction 0xfb"],
    ["bulk sub-opcode", withBody([0xfc, 18]), "0xfc 18"],
    ["SIMD sub-opcode", withBody([0xfd, 0x95, 0x02]), "0xfd 277"],
    ["atomic sub-opcode", withBody([0xfe, 4]), "0xfe 4"],
    ["catch clause", withBody([0x1f, 0x40, 1, 4, 0, 0x0b]), "catch clause"],
    [
      "recursion group",
      new Uint8Array([...header, ...section(1, [1, 0x4e, 0]), ...memory]),
      "no GC types or recursion groups",
    ],
    [
      "struct type",
      new Uint8Array([...header, ...section(1, [1, 0x5f, 0]), ...memory]),
      "no GC types or recursion groups",
    ],
    [
      "table initializer",
      new Uint8Array([
        ...header,
        ...section(1, [1, 0x60, 0, 0]),
        ...section(4, [1, 0x40, 0, 0x70, 0, 1, 0xd0, 0x70, 0x0b]),
        ...memory,
      ]),
      "table initializer",
    ],
    [
      "reserved export",
      new Uint8Array([
        ...header,
        ...memory,
        ...section(7, [1, ...name(countdownExport), 2, 0]),
      ]),
      "is reserved",
    ],
    [
      "section order",
      new Uint8Array([...header, ...memory, ...section(1, [0])]),
      "section order",
    ],
    [
      "unknown section",
      new Uint8Array([...header, ...memory, ...section(14, [])]),
      "unsupported Wasm section 14",
    ],
    [
      "value type",
      new Uint8Array([...header, ...section(1, [1, 0x60, 1, 0x75, 0])]),
      "unsupported Wasm value type 0x75",
    ],
  ];
  for (const [label, module, message] of cases) {
    let failure: unknown;
    try {
      instrument(module, 16);
    } catch (error) {
      failure = error;
    }
    assert(
      failure instanceof TypeError && failure.message.includes(message),
      `${label}: ${failure}`,
    );
  }
});

Deno.test("SDK instruments every built toolchain module", async () => {
  for (
    const module of [
      "capnp",
      "capnpc-c++",
      "capnpc-capnp",
      "capnpc-go",
      "capnpc-rust",
      "capnpc-zig",
    ]
  ) {
    const bytes = await read(`build/wasm/bin/${module}.wasm`);
    const result = instrument(bytes, defaultLimits.memoryPages);
    assert(
      WebAssembly.validate(result.bytes),
      `${module}: instrumented module is invalid`,
    );
    assert(
      result.loopChecks > 0 && result.entryChecks > 0 &&
        result.importChecks > 0,
      `${module}: no checks inserted`,
    );
    const custom = WebAssembly.Module.customSections(
      new WebAssembly.Module(new Uint8Array(bytes)),
      "name",
    );
    assert(
      result.names === (custom.length ? "renumbered" : "absent"),
      `${module}: name section ${result.names}`,
    );
  }
});

/** A direct compiler whose cpp generator is catchRetryGuest. */
async function catchRetry(options: { limits?: { stdoutBytes: number } } = {}) {
  const compiler = await createCompiler({
    compiler: trapGuest,
    generators: { cpp: catchRetryGuest },
  }, options);
  return (mode: number) =>
    compiler.generate({ request: Uint8Array.of(mode), generators: ["cpp"] });
}

Deno.test("SDK host stops trap without running guest handlers", async () => {
  const run = await catchRetry();
  // A throwing exit would reach the handler, which then returns normally.
  const exit = await rejectsWith(
    () => run(catchRetryMode.exit),
    CompileError,
    "cpp exited with status 3",
  );
  assert(
    exit.exitCode === 3 && exit.diagnostics.length === 0,
    `exit ran a handler: ${JSON.stringify(exit.diagnostics)}`,
  );
  const thrown = await rejectsWith(
    () => run(catchRetryMode.hostThrow),
    CompileError,
    "cpp trapped: WASI command failed: sockets not supported",
  );
  assert(thrown.diagnostics.length === 0, "host failure ran a handler");
  const limited = await catchRetry({ limits: { stdoutBytes: 0 } });
  const limit = await rejectsWith(
    () => limited(catchRetryMode.stdout),
    CompileError,
    "cpp trapped: WASI command failed: stdoutBytes resource limit exceeded",
  );
  assert(
    limit.exitCode === undefined && limit.diagnostics.length === 0,
    "budget stop ran a handler",
  );
  // The runtime reports what the guest wrote before a cancellation: nothing.
  const module = await compileBounded(
    catchRetryGuest,
    defaultLimits.memoryPages,
  );
  for (const mode of [catchRetryMode.spin, catchRetryMode.sleep]) {
    let cancelled: unknown;
    try {
      await runCommand(
        module,
        ["capnpc-c++"],
        Uint8Array.of(mode),
        {},
        false,
        defaultLimits,
        true,
        new JobControl({ deadline: performance.now() + 50 }),
      );
    } catch (error) {
      cancelled = error;
    }
    assert(
      cancelled instanceof Cancelled && cancelled.stderr === "" &&
        cancelled.reason instanceof DOMException &&
        cancelled.reason.name === "TimeoutError",
      `mode ${mode}: ${cancelled}`,
    );
  }
});
