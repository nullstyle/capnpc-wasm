/**
 * In-guest interruption: the module rewriter (wasm.ts), host stops that trap
 * instead of throwing into the guest (runtime.ts), and direct-mode deadlines
 * and abort signals (mod.ts). Worker cancellation is in worker_test.ts.
 */
import {
  CompileError,
  createCompiler,
  defaultLimits,
  type Modules,
} from "./mod.ts";
import { Cancelled, countdownExport, JobControl } from "./interrupt.ts";
import { CommandError, runCommand } from "./runtime.ts";
import { compileBounded, instrument } from "./wasm.ts";
import {
  bulkChargesModule,
  catchRetryGuest,
  catchRetryMode,
  costlyStep,
  costlyStepsGuest,
  escapingImportsModule,
  legacyExceptionsModule,
  namedTrapGuest,
  pollOverlapGuest,
  rewriterCoverageModule,
  startFailureGuest,
  swallowAllGuest,
} from "./testdata/interrupt_guests.ts";
import {
  assert,
  commandGuest,
  equalOutputs,
  fixture,
  leb,
  loopGuest,
  name,
  read,
  rejects,
  rejectsWith,
  section,
  simpleRequest,
  trapGuest,
} from "./testdata/support.ts";

// Stopping takes well under a millisecond on an idle host (see the SDK
// README); the bound leaves 5x headroom over a 100 ms target for loaded CI.
const timeoutMs = 200;
const lateMs = 500;

async function elapsed<T>(run: () => Promise<T>): Promise<number> {
  const started = performance.now();
  await run();
  return performance.now() - started;
}

function stoppedInTime(took: number, what: string): void {
  assert(took >= timeoutMs, `${what} stopped before its deadline: ${took} ms`);
  assert(
    took < timeoutMs + lateMs,
    `${what} ran ${took - timeoutMs} ms past its deadline`,
  );
}

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
  // V8 names Wasm frames `at bravo (wasm://wasm/<hash>:...)`.
  const frames = (trap.stack ?? "").split("\n").filter((line) =>
    line.includes("wasm://")
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
    ["unassigned SIMD sub-opcode", withBody([0xfd, 0x9a, 0x01]), "0xfd 154"],
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
    [
      "type index",
      new Uint8Array([
        ...header,
        ...section(1, [1, 0x60, 0, 0]),
        ...section(3, [1, 1]),
        ...memory,
      ]),
      "invalid Wasm type index",
    ],
    [
      "shared memory import",
      new Uint8Array([
        ...header,
        ...section(2, [1, ...name("env"), ...name("m"), 2, 3, 1, 1]),
      ]),
      "unsupported Wasm memory import",
    ],
    [
      "64-bit memory import",
      new Uint8Array([
        ...header,
        ...section(2, [1, ...name("env"), ...name("m"), 2, 4, 1]),
      ]),
      "unsupported Wasm memory import",
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

Deno.test("SDK validates the original module before instrumenting it", async () => {
  // Both originals name an index the rewrite adds, so their instrumented
  // copies are valid: global 0 becomes the countdown, which the first guest
  // would keep resetting and so never poll, and type 2 becomes the interrupt
  // import's `() -> i32`.
  const cases: [string, Uint8Array][] = [
    // loop; i32.const 1000; global.set 0; br 0; end
    [
      "global index",
      commandGuest([0x03, 0x40, 0x41, 0xe8, 0x07, 0x24, 0, 0x0c, 0, 0x0b]),
    ],
    // block (type 2); i32.const 0; end; drop
    ["type index", commandGuest([0x02, 0x02, 0x41, 0, 0x0b, 0x1a])],
  ];
  for (const [label, module] of cases) {
    assert(
      !WebAssembly.validate(new Uint8Array(module)),
      `${label}: the original is valid`,
    );
    assert(
      WebAssembly.validate(instrument(module, 16).bytes),
      `${label}: the rewrite alone no longer hides the error`,
    );
    const refused = await rejectsWith(
      () => compileBounded(module, 16),
      TypeError,
    );
    assert(
      refused.message.startsWith("the engine rejected the Wasm module: ") &&
        refused.cause instanceof WebAssembly.CompileError,
      `${label}: ${refused.message}`,
    );
  }
});

Deno.test("SDK instrumentation charges bulk operations by their size", async () => {
  const result = instrument(bulkChargesModule, 16, 64);
  // fill, copy and table_fill; the constant fill under a KiB is free.
  assert(result.bulkChecks === 3, `${result.bulkChecks} charged operations`);
  let polls = 0;
  const bulk = await exportsOf(result.bytes, () => (polls++, 0));
  const call = (name: string, ...values: number[]) =>
    (bulk[name] as (...values: number[]) => number)(...values);
  const expect = (count: number, what: string) =>
    assert(polls === count, `${what}: ${polls} polls instead of ${count}`);
  // One tick per KiB, or per 16 table entries, against a countdown of 64:
  // sizes under one tick are free, others are subtracted, and an operation
  // that uses up the countdown polls first.
  call("fill", 1023);
  expect(0, "fill under a KiB");
  call("fill", 63 * 1024);
  expect(0, "fill of 63 KiB");
  call("fill", 1024);
  expect(1, "fill that uses up the countdown");
  call("fill", 64 * 1024);
  expect(2, "fill of a whole interval");
  call("small");
  expect(2, "constant fill under a KiB");
  call("copy", 64 * 1024);
  expect(3, "copy of a whole interval");
  call("table_fill", 1024);
  expect(4, "table fill of a whole interval");
  assert(
    call("byte", 0) === 7 && call("byte", 65535) === 7 &&
      call("byte", 65536) === 7,
    "bulk results changed",
  );
  // A stop answer traps before the operation runs.
  const stopped = await exportsOf(result.bytes, () => 1);
  let trap: unknown;
  try {
    (stopped.fill as (size: number) => void)(64 * 1024);
  } catch (error) {
    trap = error;
  }
  assert(trap instanceof WebAssembly.RuntimeError, `no trap: ${trap}`);
  assert(
    (stopped.byte as (address: number) => number)(0) === 0,
    "the stopped fill ran",
  );
});

Deno.test("SDK instrumentation sends imports used as values through checking thunks", async () => {
  const result = instrument(escapingImportsModule, 16);
  // `stop` escapes through the element segment, `exported` through its
  // export; `log` is only called directly.
  assert(result.thunks === 2, `${result.thunks} thunks`);
  assert(WebAssembly.validate(result.bytes), "instrumented module is invalid");
  const logged: number[] = [];
  let armed = false;
  let stopped = false;
  const stop = () => {
    if (!armed) return;
    stopped = true;
    countdown.value = 0;
  };
  const { instance } = await WebAssembly.instantiate(result.bytes, {
    env: { stop, exported: stop, log: (value: number) => logged.push(value) },
    capnp_wasm: { interrupt: () => stopped ? 1 : 0 },
  });
  const countdown = instance.exports[countdownExport] as WebAssembly.Global;
  const calls = ["table", "tail", "reference", "declared_by_export"];
  for (const [index, name] of calls.entries()) {
    const value = (instance.exports[name] as () => number)();
    assert(
      value === index + 1 && logged.at(-1) === value,
      `${name} did not reach the import: ${value}`,
    );
  }
  armed = true;
  logged.length = 0;
  for (const name of calls) {
    stopped = false;
    countdown.value = 65536;
    let trap: unknown;
    try {
      (instance.exports[name] as () => number)();
    } catch (error) {
      trap = error;
    }
    assert(
      trap instanceof WebAssembly.RuntimeError && stopped,
      `${name} did not trap after the stop: ${trap}`,
    );
  }
  assert(logged.length === 0, `guest code ran after a stop: ${logged}`);
  // The export still names the import, not its thunk: the host calls it with
  // no check after, so a stop inside returns instead of trapping.
  stopped = false;
  (instance.exports.exported as () => void)();
  assert(stopped, "the exported import did not run");
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
  const modules: Modules = {
    compiler: trapGuest,
    generators: { cpp: catchRetryGuest },
  };
  const compiler = await createCompiler(modules, options);
  return (mode: number, timeout = timeoutMs) =>
    compiler.generate({ request: Uint8Array.of(mode), generators: ["cpp"] }, {
      timeoutMs: timeout,
    });
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

Deno.test("SDK direct jobs stop running guests at their deadline", async () => {
  const run = await catchRetry();
  // Spinning, sleeping in poll_oneoff for an hour, and endless tail calls
  // with no loop instruction all stop at the deadline.
  for (
    const mode of [
      catchRetryMode.spin,
      catchRetryMode.sleep,
      catchRetryMode.tailCalls,
    ]
  ) {
    let failure: unknown;
    const took = await elapsed(async () => {
      try {
        await run(mode);
      } catch (error) {
        failure = error;
      }
    });
    assert(
      failure instanceof DOMException && failure.name === "TimeoutError",
      `mode ${mode}: ${failure}`,
    );
    stoppedInTime(took, `mode ${mode}`);
  }
  // A compiler that timed out keeps producing the native bytes.
  const { modules, request } = await fixture();
  const compiler = await createCompiler({
    ...modules,
    generators: { ...modules.generators, cpp: loopGuest },
  });
  const expected = await (await createCompiler(modules)).compile({
    ...request,
    generators: ["rust"],
  });
  const took = await elapsed(() =>
    rejects(
      () =>
        compiler.compile({ ...request, generators: ["cpp"] }, { timeoutMs }),
      "TimeoutError",
    )
  );
  stoppedInTime(took, "loop generator");
  equalOutputs(
    await compiler.compile({ ...request, generators: ["rust"] }),
    expected,
  );
});

Deno.test("SDK direct jobs stop bulk operations and costly imports at their deadline", async () => {
  const compiler = await createCompiler({
    compiler: trapGuest,
    generators: { cpp: costlyStepsGuest },
  });
  // Each step repeats a 16 MiB fill, a fill of a million table entries, or a
  // 16 MiB random_get. At one tick per iteration the first poll would come
  // minutes after the deadline; charges and import polls stop each in time.
  for (const [step, mode] of Object.entries(costlyStep)) {
    let failure: unknown;
    const took = await elapsed(async () => {
      try {
        await compiler.generate({
          request: Uint8Array.of(mode),
          generators: ["cpp"],
        }, { timeoutMs });
      } catch (error) {
        failure = error;
      }
    });
    assert(
      failure instanceof DOMException && failure.name === "TimeoutError",
      `${step}: ${failure}`,
    );
    stoppedInTime(took, step);
  }
});

Deno.test("SDK stops a guest as a host failure when polling its job throws", async () => {
  // The guest has no imports and swallows every exception, so only its polls
  // read the signal, and an exception thrown from one would let it exit 0.
  const failure = new Error("the signal cannot be read");
  const signal = new EventTarget() as unknown as AbortSignal;
  Object.defineProperty(signal, "aborted", {
    get: () => {
      throw failure;
    },
  });
  const module = await compileBounded(swallowAllGuest, 16);
  let stopped: unknown;
  try {
    await runCommand(
      module,
      ["guest"],
      new Uint8Array(),
      {},
      true,
      defaultLimits,
      true,
      new JobControl({ signal }),
    );
  } catch (error) {
    stopped = error;
  }
  assert(
    stopped instanceof CommandError && stopped.cause === failure,
    `the failed poll did not stop the guest: ${stopped}`,
  );
});

Deno.test("SDK keeps a host failure in a start function and never runs _start", async () => {
  // _start would exit 0; the failure recorded during instantiation stands.
  const compiler = await createCompiler({
    compiler: trapGuest,
    generators: { cpp: startFailureGuest },
  });
  const failure = await rejectsWith(
    () => compiler.generate({ request: Uint8Array.of(0), generators: ["cpp"] }),
    CompileError,
  );
  assert(
    failure.kind === "trap" && failure.stage === "cpp" &&
      failure.message.startsWith("cpp trapped: WASI command failed: "),
    `start failure lost: ${failure.kind}: ${failure.message}`,
  );
});

Deno.test("SDK poll_oneoff reads the subscription before writing an overlapping event", async () => {
  // The guest exits with the userdata the event reports.
  const compiler = await createCompiler({
    compiler: trapGuest,
    generators: { cpp: pollOverlapGuest },
  });
  const exit = await rejectsWith(
    () => compiler.generate({ request: Uint8Array.of(0), generators: ["cpp"] }),
    CompileError,
    "cpp exited with status 42",
  );
  assert(exit.kind === "exit" && exit.exitCode === 42, `${exit.exitCode}`);
});

Deno.test("SDK direct jobs observe their abort signal", async () => {
  const controller = new AbortController();
  const reason = new Error("stop");
  controller.abort(reason);
  const compiler = await createCompiler({
    compiler: loopGuest,
    generators: { cpp: catchRetryGuest },
  });
  let seen: unknown;
  try {
    await compiler.compile(simpleRequest(), { signal: controller.signal });
  } catch (error) {
    seen = error;
  }
  assert(seen === reason, `pre-aborted job rejected with ${seen}`);
  // The injected checks read `aborted` while the guest runs; this signal
  // reports an abort after a few reads, as a cross-thread signal would.
  let reads = 0;
  const flipping = new EventTarget() as unknown as AbortSignal;
  Object.defineProperties(flipping, {
    aborted: { get: () => ++reads > 3 },
    reason: { value: reason },
  });
  seen = undefined;
  const took = await elapsed(async () => {
    try {
      await compiler.generate({
        request: Uint8Array.of(catchRetryMode.spin),
        generators: ["cpp"],
      }, { signal: flipping, timeoutMs: 10_000 });
    } catch (error) {
      seen = error;
    }
  });
  assert(seen === reason, `running job rejected with ${seen}`);
  assert(took < lateMs, `abort took ${took} ms`);
});

Deno.test("SDK validates direct job options before running a guest", async () => {
  const compiler = await createCompiler({
    compiler: loopGuest,
    generators: {},
  });
  const request = simpleRequest();
  request.generators = [];
  for (
    const timeout of [0, -1, Number.NaN, Infinity, 2 ** 31, "100", null]
  ) {
    await rejectsWith(
      () =>
        compiler.compile(request, { timeoutMs: timeout as unknown as number }),
      TypeError,
      "timeoutMs must be positive and at most 2147483647",
    );
  }
  await rejectsWith(
    () =>
      compiler.compile(request, {
        signal: { aborted: false } as unknown as AbortSignal,
      }),
    TypeError,
    "signal must be an AbortSignal",
  );
  await rejectsWith(
    () => compiler.compile(request, 5 as unknown as undefined),
    TypeError,
    "job options must be an object",
  );
  // The request itself is validated after the options.
  await rejectsWith(
    () =>
      compiler.compile({ ...request, entrypoints: [] }, {
        timeoutMs: 0,
      }),
    TypeError,
    "timeoutMs must be positive and at most 2147483647",
  );
});
