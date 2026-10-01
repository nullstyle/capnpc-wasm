// The termination verdicts without a browser: a fake page evaluator returns
// the samples a real engine would, so each check in termination.ts is
// exercised on every host, and measureTermination's own page function runs
// here against a fake SDK. Also the start stalls and how they are read and
// retried, the stall budget and warnings (soak-stalls.ts), and how an engine
// crash is reported instead (engine-crash.ts). Runs in test:browser-bootstrap.
import {
  checkIsolatedTermination,
  checkPlainTermination,
  measureTermination,
  type StartStall,
  type TerminationGuest,
  type TerminationMode,
  type TerminationSample,
  workerAuditScript,
} from "./termination.ts";
import {
  type EngineHealth,
  judgeStall,
  type PageTracer,
  type StallEvidence,
  stallFloorFor,
  stallFloorMs,
  stallSuspect,
  type TracedWorker,
  traceFactsSource,
  traceModuleSource,
  type WorkerFacts,
  workerTracerScript,
} from "./worker-trace.ts";
import {
  type SoakStall,
  stallBudget,
  stallJob,
  stallPlace,
  stallTitle,
  stallWarning,
} from "./soak-stalls.ts";
import {
  parseWorkerStallDrill,
  stallErrorText,
  stallFloorOf,
  type StallRuleHost,
  type StepStallEvidence,
  stepStallEvidence,
  underStallRule,
} from "./stall-rule.ts";
import { DeadlineError } from "./deadline.ts";
import { clientHistory } from "./conformance.ts";
import {
  closedTargetError,
  crashFailure,
  crashObservation,
  crashReportDirectory,
  latestCrashReport,
  summarizeCrashReport,
  TraceMirror,
} from "./engine-crash.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** The page's own facts fold (worker-trace.ts traceFactsSource), run here. */
const { capnpNewFacts, capnpFold } = new Function(
  `${traceFactsSource}\nreturn { capnpNewFacts, capnpFold };`,
)() as {
  capnpNewFacts(): WorkerFacts;
  capnpFold(facts: WorkerFacts, event: string, now: number): void;
};

/** A minute ago on this clock: well past the stall floor. */
const longAgo = () => performance.now() - 60_000;

/** Fold events into facts as the page does, one millisecond apart from `from`. */
function factsOf(events: string[], from = longAgo()): WorkerFacts {
  const facts = capnpNewFacts();
  events.forEach((event, index) => capnpFold(facts, event, from + index));
  return facts;
}

/** Fold each event as having arrived its milliseconds before now. */
function factsAgo(timed: [number, string][]): WorkerFacts {
  const now = performance.now();
  const facts = capnpNewFacts();
  for (const [ago, event] of timed) capnpFold(facts, event, now - ago);
  return facts;
}

const rejections: Record<TerminationMode, string> = {
  timeout: "TimeoutError",
  abort: "AbortError",
  dispose: "Error",
};

/**
 * An evaluator whose guests stop after `stops(guest)` ms, or never (null).
 * Unless `change` says otherwise, the worker behaves as the SDK's does: a
 * timeout or abort keeps it for a follow-up job that times out, and dispose
 * terminates it.
 */
function engineThat(
  stops: (guest: TerminationGuest) => number | null,
  change: (sample: TerminationSample) => Partial<TerminationSample> =
    () => ({}),
) {
  return <T, A>(
    _fn: (argument: A) => T | Promise<T>,
    argument: A,
    _label: string,
  ): Promise<T> => {
    const { guest, mode } = argument as unknown as {
      guest: TerminationGuest;
      mode: TerminationMode;
    };
    const sample: TerminationSample = {
      guest,
      mode,
      stall: null,
      hasCounter: true,
      countBeforeCancel: 10,
      advanceBeforeCancel: 5,
      atRejection: 20,
      final: 30,
      rejection: { name: rejections[mode], message: "" },
      rejectionAfterMs: 5,
      stoppedAfterMs: stops(guest),
      followUp: mode === "dispose"
        ? null
        : { name: "TimeoutError", afterMs: 300 },
      terminateCalls: mode === "dispose" ? 1 : 0,
      workersCreated: 1,
    };
    return Promise.resolve({ ...sample, ...change(sample) } as unknown as T);
  };
}

async function rejection(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("the check passed");
}

const engines = ["chromium", "firefox", "webkit"] as const;
const hosts = ["darwin", "linux"];

Deno.test("Every engine on every host: both guests stop within the bound", async () => {
  for (const engine of engines) {
    for (const os of hosts) {
      const result = await checkIsolatedTermination(
        engine,
        engineThat(() => 50),
        os,
      );
      assert(result.verdict.startsWith(`PASS ${engine}`), result.verdict);
      assert(
        result.observed.startsWith(
          `${engine} termination on ${os}: pure Wasm:`,
        ),
        result.observed,
      );
    }
  }
});

Deno.test("A stop counts when its last movement is within the bound", async () => {
  // The page watches for the bound plus the quiet period, so a stop at 1.2 s
  // is seen even though it is quiet only at 2.2 s; a stop at 2.5 s fails.
  const late = await checkIsolatedTermination(
    "chromium",
    engineThat(() => 1_200),
    "linux",
  );
  assert(late.verdict.startsWith("PASS chromium"), late.verdict);
  const message = await rejection(() =>
    checkIsolatedTermination("chromium", engineThat(() => 2_500), "linux")
  );
  assert(message.includes("kept running past"), message);
});

Deno.test("A counter that does not move just before the cancellation fails", async () => {
  const message = await rejection(() =>
    checkIsolatedTermination(
      "webkit",
      engineThat(() => 0, () => ({ advanceBeforeCancel: 0 })),
      "darwin",
    )
  );
  assert(message.includes("did not move within 50 ms"), message);
});

Deno.test("Every engine: a guest that keeps running fails, WebKit's pure guest included", async () => {
  for (const engine of engines) {
    for (const running of ["pure", "host"] as const) {
      const message = await rejection(() =>
        checkIsolatedTermination(
          engine,
          engineThat((guest) => guest === running ? null : 50),
          "linux",
        )
      );
      assert(message.includes("kept running past"), message);
    }
  }
});

Deno.test("A timeout or abort keeps the worker, and dispose terminates it", async () => {
  const cases: [
    string,
    (sample: TerminationSample) => Partial<TerminationSample>,
  ][] = [
    [
      "a timeout that terminates the worker",
      (sample) => sample.mode === "timeout" ? { terminateCalls: 1 } : {},
    ],
    [
      "a replacement worker",
      (sample) => sample.mode === "abort" ? { workersCreated: 2 } : {},
    ],
    [
      "a dispose that terminates nothing",
      (sample) => sample.mode === "dispose" ? { terminateCalls: 0 } : {},
    ],
    [
      "a follow-up job that fails differently",
      (sample) =>
        sample.mode === "abort"
          ? { followUp: { name: "Error", afterMs: 5 } }
          : {},
    ],
  ];
  for (const [label, change] of cases) {
    const message = await rejection(() =>
      checkIsolatedTermination(
        "chromium",
        engineThat(() => 50, change),
        "linux",
      )
    );
    assert(
      message.includes("expected 1 and") ||
        message.includes("follow-up job on the same client"),
      `${label}: ${message}`,
    );
  }
});

Deno.test("Without isolation: the timeout keeps its worker for the next job", async () => {
  const plain = engineThat(() => null, () => ({ hasCounter: false }));
  for (const engine of engines) {
    const result = await checkPlainTermination(engine, plain);
    assert(result.verdict.startsWith(`PASS ${engine}`), result.verdict);
  }
  const terminated = await rejection(() =>
    checkPlainTermination(
      "webkit",
      engineThat(() => null, () => ({ terminateCalls: 1 })),
    )
  );
  assert(terminated.includes("expected 1 and 0"), terminated);
});

const healthy: EngineHealth = {
  plainWorker: "up after 1 ms",
  workerCompile: "compiled after 1 ms",
  pageCompile: "compiled after 1 ms",
  healthy: true,
};

/**
 * Run measureTermination's page function here, against a fake SDK whose
 * guest counts every 10 ms in shared memory, as the probe does (the count and
 * the millisecond of its latest call), until `stopAfterMs` after its job is
 * rejected. `neverRuns` keeps the guest from counting at all; `initFails`
 * rejects the factory as an init timeout would, and `initError` with another
 * error; `failsAfterMs` rejects the job early with a CompileError; and
 * `ignoresTimeout` never times the job out.
 */
async function measureFake(
  stopAfterMs: number,
  mode: TerminationMode,
  fake: {
    neverRuns?: boolean;
    initFails?: boolean;
    initError?: Error;
    failsAfterMs?: number;
    ignoresTimeout?: boolean;
    bounds?: { timeoutMs?: number; startMs?: number };
  } = {},
): Promise<TerminationSample> {
  const counter = new Int32Array(new SharedArrayBuffer(8));
  let stopAt = fake.neverRuns ? -Infinity : Infinity;
  const ticker = setInterval(() => {
    if (performance.now() < stopAt) {
      Atomics.add(counter, 0, 1);
      Atomics.store(counter, 1, Math.round(performance.now()));
    }
  }, 10);
  const events: string[] = [];
  const facts = capnpNewFacts();
  const record = (...recorded: string[]) => {
    for (const event of recorded) {
      events.push(event);
      capnpFold(facts, event, performance.now());
    }
  };
  const audit = {
    created: 0,
    terminated: 0,
    probes: [] as (Int32Array | null)[],
    traces: [] as string[][],
    facts: [] as WorkerFacts[],
  };
  // The jobs a dispose() rejects, as the SDK's does.
  const pending = new Set<(error: Error) => void>();
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.capnpWorkerAudit = audit;
  scope.capnpEngineHealth = () => Promise.resolve(healthy);
  scope.capnpTermination = {
    sdk: {
      createWorkerCompiler() {
        audit.created++;
        audit.traces.push(events);
        audit.facts.push(facts);
        record(
          "page:post:init:1",
          "0:started",
          "0:idle:start",
          "1:message:init:1",
        );
        if (fake.initFails) {
          return Promise.reject(
            new DOMException("compilation timed out", "TimeoutError"),
          );
        }
        if (fake.initError) return Promise.reject(fake.initError);
        record("2:reply:1", "2:idle:1", "page:reply:1");
        audit.probes.push(counter);
        return Promise.resolve({
          compile(
            _job: unknown,
            options: { signal?: AbortSignal; timeoutMs?: number } = {},
          ) {
            record("page:post:compile:2", "3:message:compile:2");
            return new Promise((_resolve, reject) => {
              const stop = (error: Error) => {
                clearTimeout(timer);
                pending.delete(stop);
                stopAt = Math.min(stopAt, performance.now() + stopAfterMs);
                reject(error);
              };
              pending.add(stop);
              const timer = fake.failsAfterMs !== undefined
                ? setTimeout(() => {
                  const error = new Error("cpp trapped: an SDK regression");
                  error.name = "CompileError";
                  stop(error);
                }, fake.failsAfterMs)
                : fake.ignoresTimeout
                ? undefined
                : setTimeout(
                  () =>
                    stop(new DOMException("the job stopped", "TimeoutError")),
                  options.timeoutMs ?? 30_000,
                );
              options.signal?.addEventListener(
                "abort",
                () => stop(new DOMException("the job stopped", "AbortError")),
              );
            });
          },
          dispose() {
            for (const stop of [...pending]) {
              stop(new Error("worker compiler was disposed"));
            }
          },
        });
      },
    },
    modules: { pure: {}, host: {} },
    probeURLs: { pure: "pure", host: "host" },
  };
  const local = <T, A>(
    fn: (argument: A) => Promise<T> | T,
    argument: A,
  ): Promise<T> => Promise.resolve(fn(argument));
  try {
    return await measureTermination(
      local,
      "pure",
      mode,
      "fake guest",
      fake.bounds,
    );
  } finally {
    clearInterval(ticker);
    delete scope.capnpWorkerAudit;
    delete scope.capnpEngineHealth;
    delete scope.capnpTermination;
  }
}

Deno.test("measureTermination sees a stop just inside the bound, and one that never comes", async () => {
  // Quiet for a second only at 2.2 s: a window of the bound alone would miss it.
  const late = await measureFake(1_200, "timeout", {
    bounds: { timeoutMs: 300 },
  });
  assert(
    late.stall === null && late.stoppedAfterMs !== null &&
      late.stoppedAfterMs >= 1_100 && late.stoppedAfterMs <= 1_400,
    `a stop at 1.2 s read as ${late.stoppedAfterMs}`,
  );
  assert(
    (late.advanceBeforeCancel ?? 0) > 0 &&
      late.followUp?.name === "TimeoutError",
    `unexpected sample: ${JSON.stringify(late)}`,
  );
  const running = await measureFake(Infinity, "abort");
  assert(
    running.stoppedAfterMs === null && running.rejection.name === "AbortError",
    `a guest that never stops read as ${running.stoppedAfterMs}`,
  );
});

Deno.test("measureTermination reports a worker or guest that does not start as a start stall", async () => {
  const init = await measureFake(0, "abort", { initFails: true });
  assert(
    init.stall?.stage === "init" &&
      init.stall.reason ===
        "the probe worker did not initialize within 10000 ms" &&
      init.stall.expected === "init:1" &&
      init.stall.error === "TimeoutError: compilation timed out" &&
      init.stall.events.includes("1:message:init:1") &&
      init.stall.health.healthy,
    `an init timeout read as ${JSON.stringify(init)}`,
  );
  const idle = await measureFake(0, "abort", {
    neverRuns: true,
    bounds: { startMs: 300 },
  });
  assert(
    idle.stall?.stage === "start" && idle.stall.count === 0 &&
      idle.stall.expected === "compile:2" && idle.stall.error === null &&
      idle.stall.reason ===
        "the guest did not run for a 50 ms window within 300 ms of its job",
    `a guest that never ran read as ${JSON.stringify(idle)}`,
  );
  const late = await measureFake(0, "timeout", {
    neverRuns: true,
    bounds: { timeoutMs: 300 },
  });
  assert(
    late.stall?.stage === "start" &&
      late.stall.reason ===
        "the guest did not run for a 50 ms window before its 300 ms deadline" &&
      late.stall.error === "TimeoutError: the job stopped",
    `a guest that never ran before its deadline read as ${
      JSON.stringify(late)
    }`,
  );
});

Deno.test("measureTermination fails a worker that fails, and a job that ends early, instead of reading a stall", async () => {
  // A worker.js that throws while it loads makes the factory fail at once:
  // the SDK's failure, not a stall.
  const failed = await rejection(() =>
    measureFake(0, "abort", {
      initError: new Error("Uncaught SyntaxError: worker.js failed to load"),
    })
  );
  assert(
    failed ===
      "the probe worker failed to initialize: Error: Uncaught SyntaxError: worker.js failed to load",
    `a factory failure read as ${failed}`,
  );
  // A timeout job that ends before its deadline with a CompileError reaches
  // the checks, which fail it, whether or not its guest ran for a window.
  for (const neverRuns of [false, true]) {
    const early = await measureFake(0, "timeout", {
      neverRuns,
      failsAfterMs: 75,
    });
    assert(
      early.stall === null && early.rejection.name === "CompileError",
      `a job that failed early read as ${JSON.stringify(early)}`,
    );
    const checked = await rejection(() =>
      checkIsolatedTermination(
        "webkit",
        engineThat(() => 0, (sample) =>
          sample.guest === "pure" && sample.mode === "timeout" ? early : {}),
        "linux",
        () =>
          Promise.resolve(),
      )
    );
    assert(
      checked.startsWith(
        "webkit pure guest, timeout: rejected with CompileError (cpp trapped: an SDK regression), expected TimeoutError",
      ),
      `the checks passed a job that failed early: ${checked}`,
    );
  }
  // A timeout that never fires is the SDK's too.
  const never = await rejection(() =>
    measureFake(0, "timeout", {
      ignoresTimeout: true,
      bounds: { timeoutMs: 300 },
    })
  );
  assert(
    never ===
      "the job did not time out within 5300 ms of its start, although its deadline was 300 ms",
    `a timeout that never fired read as ${never}`,
  );
});

function startStall(
  stage: "init" | "start",
  events: string[],
  count: number | null = null,
  health: EngineHealth = healthy,
  error: string | null = null,
): StartStall {
  const kind = stage === "init" ? "init" : "compile";
  const facts = factsOf(events);
  const expected =
    Object.keys(facts.posts).filter((post) => post.startsWith(`${kind}:`)).at(
      -1,
    ) ?? null;
  return {
    stage,
    reason: `the probe worker did not ${stage}`,
    afterMs: 10_000,
    expected,
    error,
    events,
    count,
    health,
    facts,
    at: performance.now(),
  };
}

Deno.test("A start stall points at the SDK only where the engine did its part", () => {
  const initialized = [
    "page:post:init:1",
    "0:started",
    "0:idle:start",
    "1:message:init:1",
    "1:compile1:start:73",
    "2:compile1:end",
  ];
  const instantiated = [
    ...initialized,
    "3:reply:1",
    "3:idle:1",
    "page:reply:1",
    "page:post:compile:2",
    "4:message:compile:2",
    "5:instantiate1:start",
    "6:instantiate1:end",
  ];
  const cases: [string, StartStall, "sdk" | "engine" | "slow"][] = [
    ["the page never posted init", startStall("init", ["0:started"]), "sdk"],
    [
      "a wait that ended with an error, not a timeout",
      startStall(
        "init",
        ["page:post:init:1"],
        null,
        healthy,
        "Error: worker script failed to load",
      ),
      "sdk",
    ],
    [
      "an init timeout",
      startStall(
        "init",
        ["page:post:init:1"],
        null,
        healthy,
        "TimeoutError: compilation timed out",
      ),
      "engine",
    ],
    [
      "an engine that no longer compiles Wasm",
      startStall("init", initialized, null, { ...healthy, healthy: false }),
      "engine",
    ],
    [
      "a worker that never started",
      startStall("init", ["page:post:init:1"]),
      "engine",
    ],
    [
      "an init message never delivered to the idle worker",
      startStall("init", ["page:post:init:1", "0:started", "0:idle:start"]),
      "engine",
    ],
    [
      "an init message the worker never took, its own code holding its thread after starting",
      startStall("init", ["page:post:init:1", "0:started"]),
      "sdk",
    ],
    [
      "a compile that never finished",
      startStall("init", initialized.slice(0, 5)),
      "engine",
    ],
    [
      "a worker that did its part and never answered",
      startStall("init", initialized),
      "sdk",
    ],
    [
      "a reply the worker sent that never reached the page",
      startStall("init", [...initialized, "3:reply:1"]),
      "engine",
    ],
    [
      "a reply that reached the page, which the client never used",
      startStall("init", [...initialized, "3:reply:1", "page:reply:1"]),
      "sdk",
    ],
    [
      "a job never delivered to the idle worker",
      startStall("start", instantiated.slice(0, 10), 0),
      "engine",
    ],
    [
      "a job never taken, the worker's own code holding its thread after answering init",
      startStall("start", [
        ...initialized,
        "3:reply:1",
        "page:reply:1",
        "page:post:compile:2",
      ], 0),
      "sdk",
    ],
    [
      "an instantiation that never finished",
      startStall("start", instantiated.slice(0, 12), 0),
      "engine",
    ],
    [
      "a guest that ran, only late",
      startStall("start", instantiated, 7),
      "engine",
    ],
    [
      "a guest that never ran on a healthy engine",
      startStall("start", instantiated, 0),
      "sdk",
    ],
  ];
  for (const [label, stall, expected] of cases) {
    const suspect = stallSuspect(stall);
    assert(suspect === expected, `${label}: read as ${suspect}`);
  }
});

Deno.test("A soak recovery stall is read by the same rule", () => {
  // The soak's evidence: the page's last post to the stalled worker, if it
  // posted anything for the recovery, and no counter. The two cases where the
  // soak's own reading used to differ are fixed by the shared rule.
  const soak = (
    expected: string | null,
    events: string[],
    error = "TimeoutError: compilation timed out",
  ): StallEvidence => ({
    expected,
    error,
    events,
    health: healthy,
    count: null,
    facts: expected === null ? null : factsOf(events),
    at: performance.now(),
  });
  const received = [
    "0:started",
    "0:idle:start",
    "page:post:compile:9",
    "40:message:compile:9",
    "41:instantiate7:start",
    "42:instantiate7:end",
  ];
  const cases: [string, StallEvidence, "sdk" | "engine", string][] = [
    [
      "a recovery the page never posted",
      soak(null, ["30:reply:8", "page:reply:8"]),
      "sdk",
      "the page never posted the message the worker had to answer",
    ],
    [
      "a received job left unanswered while its compile is still running",
      soak("compile:9", [...received.slice(0, 4), "41:compile3:start:5"]),
      "engine",
      "the engine never finished compile3",
    ],
    [
      "a received job left unanswered with every engine operation finished",
      soak("compile:9", received),
      "sdk",
      "the engine did its part and stayed healthy, yet the worker never answered compile:9",
    ],
    [
      "a recovery that failed with an error",
      soak("compile:9", received, "CompileError: cpp trapped"),
      "sdk",
      "the wait ended with CompileError: cpp trapped, a failure, not a stall",
    ],
    [
      "a new worker whose script never ran",
      soak("init:10", ["page:post:init:10"]),
      "engine",
      "the engine never ran the worker's script",
    ],
    [
      // CI job 108181045701's WebKit soak stall, 20 s after the post.
      "a received init whose second compile never finished",
      soak("init:18", [
        "page:post:init:18",
        "0:started",
        "5:message:init:18",
        "85:compile1:start:2095234",
        "102:compile1:end",
        "157:compile2:start:1774315",
      ]),
      "engine",
      "the engine never finished compile2",
    ],
  ];
  for (const [label, evidence, suspect, because] of cases) {
    const judged = judgeStall(evidence);
    assert(
      judged.suspect === suspect && judged.because === because,
      `${label}: read as ${JSON.stringify(judged)}`,
    );
  }
});

/** Evidence for `expected` from a worker's facts, taken now. */
function evidenceOf(
  expected: string | null,
  facts: WorkerFacts | null,
  error = "TimeoutError: compilation timed out",
): StallEvidence {
  return {
    expected,
    error,
    events: [],
    health: healthy,
    count: null,
    facts,
    at: performance.now(),
  };
}

/** A worker that started a minute ago, answered init, and was sent compile:12. */
const answeredTwelve: [number, string][] = [
  [60_000, "page:post:init:1"],
  [59_990, "0:started"],
  [59_990, "0:idle:start"],
  [59_980, "1:message:init:1"],
  [59_000, "900:reply:1"],
  [59_000, "900:idle:1"],
  [59_000, "page:reply:1"],
  [58_000, "page:post:compile:12"],
  [58_000, "1900:message:compile:12"],
  [40_000, "19900:reply:12"],
  [40_000, "page:reply:12"],
];

Deno.test("A held thread, a busy worker, and a post to a terminated worker point at the SDK", () => {
  const cases: [string, StallEvidence, string, string][] = [
    [
      "a worker whose own code kept its thread after its reply (I1)",
      evidenceOf(
        "generate:13",
        factsAgo([...answeredTwelve, [40_000, "page:post:generate:13"]]),
      ),
      "sdk",
      "the worker never returned to its event loop after answering 12: its own code held its thread or kept the trace's idle timer from running, so it never took generate:13",
    ],
    [
      "the same worker, idle after its reply",
      evidenceOf(
        "generate:13",
        factsAgo([
          ...answeredTwelve,
          [40_000, "19900:idle:12"],
          [40_000, "page:post:generate:13"],
        ]),
      ),
      "engine",
      "the engine never delivered generate:13 to the idle worker",
    ],
    [
      "a worker whose own code kept its thread after starting",
      evidenceOf(
        "init:1",
        factsAgo([[60_000, "page:post:init:1"], [59_990, "0:started"]]),
      ),
      "sdk",
      "the worker never returned to its event loop after starting: its own code held its thread or kept the trace's idle timer from running, so it never took init:1",
    ],
    [
      "a post to a worker still working on its last message",
      evidenceOf(
        "compile:13",
        factsAgo([
          ...answeredTwelve.slice(0, 9),
          [30_000, "page:post:compile:13"],
        ]),
      ),
      "sdk",
      "the page posted compile:13 while the worker still worked on compile:12",
    ],
    [
      "a post to a worker the page had terminated",
      evidenceOf(
        "generate:13",
        factsAgo([
          ...answeredTwelve,
          [40_000, "19900:idle:12"],
          [30_000, "page:terminate"],
          [30_000, "page:post:generate:13"],
        ]),
      ),
      "sdk",
      "the page posted generate:13 to a worker it had terminated",
    ],
    [
      "a worker terminated after the post, as the SDK's timeout does",
      evidenceOf(
        "generate:13",
        factsAgo([
          ...answeredTwelve,
          [40_000, "19900:idle:12"],
          [40_000, "page:post:generate:13"],
          [10_000, "page:terminate"],
        ]),
      ),
      "engine",
      "the engine never delivered generate:13 to the idle worker",
    ],
    [
      "every post answered at the page, and the client unsettled",
      { ...evidenceOf(null, null), answered: true },
      "sdk",
      "every message the page posted during the step was answered at the page, yet the SDK's client did not settle",
    ],
    [
      "a reply that reached the page, and the client unsettled",
      evidenceOf("compile:12", factsAgo(answeredTwelve)),
      "sdk",
      "the worker's reply to compile:12 reached the page, yet the SDK's client did not settle",
    ],
  ];
  for (const [label, evidence, suspect, because] of cases) {
    const judged = judgeStall(evidence);
    assert(
      judged.suspect === suspect && judged.because === because,
      `${label}: read as ${JSON.stringify(judged)}`,
    );
  }
});

Deno.test("The engine is blamed only for an item without progress for the stall floor", () => {
  assert(stallFloorMs === 5_000, `the floor is ${stallFloorMs} ms`);
  const init: [number, string][] = [
    [30_000, "page:post:init:1"],
    [29_990, "0:started"],
    [29_990, "0:idle:start"],
    [29_980, "1:message:init:1"],
  ];
  // 56 compiles finished within the SDK's 30 s, and the 57th began 5 ms
  // before its timeout.
  const busy = [...init];
  for (let n = 1; n <= 56; n++) {
    busy.push(
      [29_000 - n * 500, `${n}:compile${n}:start:1000`],
      [28_700 - n * 500, `${n}:compile${n}:end`],
    );
  }
  const idle: [number, string][] = [
    ...init,
    [29_000, "990:reply:1"],
    [29_000, "990:idle:1"],
    [29_000, "page:reply:1"],
  ];
  const deadline =
    "TimeoutError: no progress: webkit worker replay generic-rpc did not finish within 60 seconds";
  const cases: [string, StallEvidence, string, RegExp][] = [
    [
      "a compile begun 5 ms before the timeout, after 56 finished",
      evidenceOf(
        "init:1",
        factsAgo([...busy, [5, "29000:compile57:start:1000"]]),
      ),
      "slow",
      /^compile57 was still in progress, and the latest progress was only [0-9] ms before the stall$/,
    ],
    [
      "a compile begun 20 s before the stall, nothing since",
      evidenceOf(
        "init:1",
        factsAgo([...init, [20_000, "9990:compile1:start:1000"]]),
      ),
      "engine",
      /^the engine never finished compile1$/,
    ],
    [
      "a compile begun 20 s before the stall, while another finished 2 s before",
      evidenceOf(
        "init:1",
        factsAgo([
          ...init,
          [20_000, "9990:compile1:start:1000"],
          [3_000, "26990:compile2:start:1000"],
          [2_000, "27990:compile2:end"],
        ]),
      ),
      "slow",
      /^compile1 was still in progress, and the latest progress was only 20[0-9][0-9] ms before the stall$/,
    ],
    [
      "a step deadline 1 ms after its post to an idle worker",
      evidenceOf(
        "compile:2",
        factsAgo([...idle, [1, "page:post:compile:2"]]),
        deadline,
      ),
      "slow",
      /^the idle worker had not received compile:2, and the latest progress was only [0-9] ms before the stall$/,
    ],
    [
      "a step deadline 20 s after its post to an idle worker",
      evidenceOf(
        "compile:2",
        factsAgo([...idle, [20_000, "page:post:compile:2"]]),
        deadline,
      ),
      "engine",
      /^the engine never delivered compile:2 to the idle worker$/,
    ],
    [
      "a new worker that started and went idle after the post, 20 s ago",
      evidenceOf(
        "init:1",
        factsAgo([
          [20_050, "page:post:init:1"],
          [20_000, "0:started"],
          [20_000, "0:idle:start"],
        ]),
      ),
      "engine",
      /^the engine never delivered init:1 to the idle worker$/,
    ],
    [
      "a new worker that started and went idle 1 s ago",
      evidenceOf(
        "init:1",
        factsAgo([
          [20_050, "page:post:init:1"],
          [1_000, "0:started"],
          [1_000, "0:idle:start"],
        ]),
      ),
      "slow",
      /^the idle worker had not received init:1, and the latest progress was only 10[0-9][0-9] ms before the stall$/,
    ],
    [
      "a worker not started 1 s after the post",
      evidenceOf("init:1", factsAgo([[1_000, "page:post:init:1"]])),
      "slow",
      /^the worker had not started, and the latest progress was only 10[0-9][0-9] ms before the stall$/,
    ],
    [
      "a worker not started 20 s after the post",
      evidenceOf("init:1", factsAgo([[20_000, "page:post:init:1"]])),
      "engine",
      /^the engine never ran the worker's script$/,
    ],
    [
      "a reply posted 1 s ago that has not reached the page",
      evidenceOf("init:1", factsAgo([...init, [1_000, "28990:reply:1"]])),
      "slow",
      /^the worker's reply to init:1 had not reached the page, and the latest progress was only 10[0-9][0-9] ms before the stall$/,
    ],
    [
      "a reply posted 20 s ago that never reached the page",
      evidenceOf(
        "init:1",
        factsAgo([...init, [20_000, "9990:reply:1"], [20_000, "9990:idle:1"]]),
      ),
      "engine",
      /^the engine never delivered the worker's reply to init:1$/,
    ],
  ];
  for (const [label, evidence, suspect, because] of cases) {
    const judged = judgeStall(evidence);
    assert(
      judged.suspect === suspect && because.test(judged.because),
      `${label}: read as ${JSON.stringify(judged)}`,
    );
  }
});

Deno.test("An unfinished instantiation that runs a start function points at the SDK", () => {
  const job: [number, string][] = [
    ...answeredTwelve.slice(0, 7),
    [20_000, "page:post:compile:2"],
    [20_000, "1900:message:compile:2"],
  ];
  const runsStart = judgeStall(
    evidenceOf(
      "compile:2",
      factsAgo([...job, [19_000, "2900:instantiate1:start:runs-start"]]),
    ),
  );
  assert(
    runsStart.suspect === "sdk" &&
      runsStart.because ===
        "instantiate1 runs the guest's start function, guest code the SDK must stop, and never finished",
    JSON.stringify(runsStart),
  );
  const plain = judgeStall(
    evidenceOf(
      "compile:2",
      factsAgo([...job, [19_000, "2900:instantiate1:start"]]),
    ),
  );
  assert(
    plain.suspect === "engine" &&
      plain.because === "the engine never finished instantiate1",
    JSON.stringify(plain),
  );
});

Deno.test("A start stall that points at the engine is retried once, then tolerated", async () => {
  const engineStall = startStall("init", ["page:post:init:1"]);
  const stallingPureAbort = (stall: StartStall, times = 1) => {
    let left = times;
    return engineThat(
      () => 50,
      (sample) =>
        sample.guest === "pure" && sample.mode === "abort" && left-- > 0
          ? { stall }
          : {},
    );
  };
  const tolerated: string[] = [];
  const result = await checkIsolatedTermination(
    "webkit",
    stallingPureAbort(engineStall),
    "linux",
    (label, stall) => {
      tolerated.push(`${label}: ${stall.stage}`);
      return Promise.resolve();
    },
  );
  assert(
    result.verdict.startsWith("PASS webkit") &&
      tolerated.join() === "webkit isolated termination pure abort: init",
    `tolerated ${tolerated.join()}: ${result.verdict}`,
  );
  const unbudgeted = await rejection(() =>
    checkIsolatedTermination("webkit", stallingPureAbort(engineStall), "linux")
  );
  assert(
    unbudgeted.includes("the probe worker did not init"),
    `without a budget: ${unbudgeted}`,
  );
  const twice = await rejection(() =>
    checkIsolatedTermination(
      "webkit",
      stallingPureAbort(engineStall, 2),
      "linux",
      () => Promise.resolve(),
    )
  );
  assert(twice.includes("stalled twice"), `twice: ${twice}`);
  const sdkStall = startStall("init", [
    "page:post:init:1",
    "0:started",
    "1:message:init:1",
  ]);
  const sdk = await rejection(() =>
    checkIsolatedTermination(
      "webkit",
      stallingPureAbort(sdkStall),
      "linux",
      () => Promise.resolve(),
    )
  );
  assert(
    sdk.includes(
      "the evidence points at the SDK: the engine did its part and stayed healthy, yet the worker never answered init:1",
    ),
    `SDK suspect: ${sdk}`,
  );
  let left = 1;
  const plainTolerated: string[] = [];
  const plain = await checkPlainTermination(
    "chromium",
    engineThat(
      () => null,
      () =>
        left-- > 0
          ? { hasCounter: false, stall: engineStall }
          : { hasCounter: false },
    ),
    (label) => {
      plainTolerated.push(label);
      return Promise.resolve();
    },
  );
  assert(
    plain.verdict.startsWith("PASS chromium") &&
      plainTolerated.join() === "chromium plain termination timeout",
    `plain: tolerated ${plainTolerated.join()}: ${plain.verdict}`,
  );
});

Deno.test("the soak stall budget defaults to one per job, and zero is strict", () => {
  const name = "CAPNP_SOAK_STALL_BUDGET";
  const previous = Deno.env.get(name);
  try {
    Deno.env.delete(name);
    assert(stallBudget() === 1, "the default budget is not 1");
    Deno.env.set(name, "0");
    assert(stallBudget() === 0, "0 is not strict");
    Deno.env.set(name, "3");
    assert(stallBudget() === 3, "3 was not read");
    for (const bad of ["-1", "1.5", "one"]) {
      Deno.env.set(name, bad);
      let thrown: unknown;
      try {
        stallBudget();
      } catch (error) {
        thrown = error;
      }
      assert(thrown instanceof TypeError, `${bad} was accepted`);
    }
  } finally {
    if (previous === undefined) Deno.env.delete(name);
    else Deno.env.set(name, previous);
  }
});

Deno.test("soak stalls count against the CI job and warn in one line", () => {
  const names = [
    "GITHUB_ACTIONS",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_JOB",
  ];
  const previous = names.map((name) => Deno.env.get(name));
  try {
    for (const name of names) Deno.env.delete(name);
    assert(stallJob() === "local", `outside CI the job is ${stallJob()}`);
    Deno.env.set("GITHUB_ACTIONS", "true");
    Deno.env.set("GITHUB_RUN_ID", "42");
    Deno.env.set("GITHUB_RUN_ATTEMPT", "2");
    Deno.env.set("GITHUB_JOB", "browsers");
    assert(stallJob() === "42.2.browsers", `in CI the job is ${stallJob()}`);
  } finally {
    names.forEach((name, index) => {
      const value = previous[index];
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    });
  }
  const stall: SoakStall = {
    job: "local",
    engine: "webkit",
    os: "linux",
    cycle: 5,
    mode: "abort",
    at: new Date(0).toISOString(),
    summary: "50% of a trace\nsecond line",
    detail: null,
  };
  const warning = stallWarning(stall);
  assert(
    warning ===
      "::warning title=Soak recovery stall (webkit)::cycle 5 (abort): 50%25 of a trace%0Asecond line",
    warning,
  );
  const start = stallWarning({
    job: "local",
    engine: "webkit",
    os: "linux",
    kind: "termination",
    mode: "webkit isolated termination pure abort",
    at: new Date(0).toISOString(),
    summary: "the probe worker did not initialize within 10000 ms",
    detail: null,
  });
  assert(
    start ===
      "::warning title=Worker start stall (webkit)::webkit isolated termination pure abort: the probe worker did not initialize within 10000 ms",
    start,
  );
});

Deno.test("an engine crash is reported with its evidence and never budgeted", async () => {
  const mirror = new TraceMirror();
  mirror.record("main", 0, "0:started");
  mirror.record("main", 1, "page:post:init:8");
  mirror.record("main", 1, "0:started");
  mirror.record("isolated", 0, "0:started");
  assert(
    JSON.stringify(mirror.last("main")) ===
        '{"worker":1,"events":["page:post:init:8","0:started"]}' &&
      mirror.last("plain") === null,
    `mirror: ${JSON.stringify(mirror.last("main"))}`,
  );
  for (let n = 0; n < 70; n++) mirror.record("main", 1, `${n}:event`);
  assert(
    mirror.last("main")!.events.length <= 60,
    "the mirror kept more than 60 events of a worker",
  );
  assert(
    closedTargetError(
      new Error(
        "page.evaluate: Target page, context or browser has been closed",
      ),
    ) && closedTargetError(new Error("page.evaluate: Target crashed")) &&
      !closedTargetError(
        new Error("page.evaluate: TimeoutError: compilation timed out"),
      ),
    "closed-target errors misread",
  );
  const crash = {
    event: "the main page crashed",
    step: "webkit worker timeout recovery cycle 10",
    cycle: 10,
    page: "main",
  };
  const observed = crashObservation(
    "webkit",
    crash,
    { worker: 1, events: ["page:post:compile:9"] },
    null,
    "/reports",
  );
  assert(
    observed ===
      'OBSERVED webkit engine crash: the main page crashed during webkit worker timeout recovery cycle 10 (soak cycle 10); the last worker trace that reached the driver (main page, worker 1): ["page:post:compile:9"]; crash report: none written to /reports since the run started',
    observed,
  );
  assert(
    crashFailure("webkit", crash) ===
      "webkit: engine crash: the main page crashed during webkit worker timeout recovery cycle 10 (soak cycle 10); a crash is not a stall, and the stall budget does not cover it",
    crashFailure("webkit", crash),
  );
  assert(
    crashReportDirectory("darwin", "/Users/a") ===
        "/Users/a/Library/Logs/DiagnosticReports" &&
      crashReportDirectory("linux", "/home/a") === null,
    "crash report directory",
  );
  // The newest report of the engine's processes since the run started.
  const now = Date.now();
  const entries = [
    {
      name: "com.apple.WebKit.WebContent.Development-old.ips",
      time: now - 60_000,
    },
    { name: "test-2026.ips", time: now },
    { name: "com.apple.WebKit.WebContent.Development-new.ips", time: now },
    { name: "Playwright-2026.ips", time: now - 500 },
  ];
  const list = () => Promise.resolve(entries);
  const since = now - 1000;
  assert(
    await latestCrashReport("webkit", since, {
      directory: "/reports",
      waitMs: 0,
      list,
    }) === "/reports/com.apple.WebKit.WebContent.Development-new.ips",
    "the newest WebKit report was not chosen",
  );
  assert(
    await latestCrashReport("chromium", since, {
          directory: "/reports",
          waitMs: 0,
          list,
        }) === null &&
      await latestCrashReport("webkit", since, {
          directory: "/nonexistent/DiagnosticReports",
          waitMs: 0,
        }) === null &&
      await latestCrashReport("webkit", since, {
          directory: null,
          waitMs: 0,
        }) ===
        null,
    "a report of another engine, or no directory, was reported",
  );
});

Deno.test("a crash report is summarized in one line", () => {
  const report = [
    JSON.stringify({ app_name: "com.apple.WebKit.WebContent.Development" }),
    JSON.stringify({
      procName: "com.apple.WebKit.WebContent.Development",
      exception: {
        type: "EXC_BAD_ACCESS",
        signal: "SIGSEGV",
        subtype: "KERN_INVALID_ADDRESS at 0x10",
      },
      termination: { namespace: "SIGNAL", indicator: "Segmentation fault: 11" },
      faultingThread: 1,
      threads: [
        { frames: [] },
        {
          triggered: true,
          name: "WebCore: Worker",
          frames: [
            { imageIndex: 0, symbol: "JSC::Wasm::OMGPlan::work" },
            { imageIndex: 1, imageOffset: 4096 },
          ],
        },
      ],
      usedImages: [{ name: "JavaScriptCore" }, { name: "WebCore" }],
    }),
  ].join("\n");
  const summary = summarizeCrashReport(report);
  assert(
    summary ===
      "com.apple.WebKit.WebContent.Development: EXC_BAD_ACCESS SIGSEGV KERN_INVALID_ADDRESS at 0x10 (SIGNAL Segmentation fault: 11); WebCore: Worker: JavaScriptCore!JSC::Wasm::OMGPlan::work < WebCore!+4096",
    summary,
  );
  assert(
    summarizeCrashReport("not a report") === "an unreadable crash report",
    "an unreadable report was summarized",
  );
});

Deno.test("the worker stall drill parses its entries and refuses others", () => {
  const drills = parseWorkerStallDrill(
    "worker resource limits=job*2, Studio adapter ,hostile guests=silent",
  );
  assert(
    JSON.stringify(drills) ===
      JSON.stringify([
        { text: "worker resource limits", mode: "job", remaining: 2 },
        { text: "Studio adapter", mode: "start", remaining: 1 },
        { text: "hostile guests", mode: "silent", remaining: 1 },
      ]),
    JSON.stringify(drills),
  );
  assert(
    parseWorkerStallDrill(undefined).length === 0 &&
      parseWorkerStallDrill(" ").length === 0,
    "an unset drill armed something",
  );
  for (const bad of ["x=later", "x*0", "=start"]) {
    let thrown: unknown;
    try {
      parseWorkerStallDrill(bad);
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof TypeError, `${bad} was accepted`);
  }
});

Deno.test("only an SDK timeout or a step deadline counts as a stall", () => {
  assert(
    stallErrorText(
      new Error("page.evaluate: TimeoutError: compilation timed out\n    at x"),
    ) === "TimeoutError: compilation timed out",
    "a page TimeoutError was not a stall",
  );
  assert(
    stallErrorText(new DeadlineError("webkit load SDK", 60_000)) ===
      "TimeoutError: no progress: webkit load SDK did not finish within 60 seconds",
    "a step deadline was not a stall",
  );
  for (
    const error of [
      new Error("page.evaluate: CompileError: cpp exited with status 1"),
      new Error("expected CompileError, received TimeoutError"),
      new TypeError("TimeoutError"),
    ]
  ) {
    assert(stallErrorText(error) === null, `${error.message} read as a stall`);
  }
});

const healthyPage: EngineHealth = {
  plainWorker: "up after 1 ms",
  workerCompile: "compiled after 1 ms",
  pageCompile: "compiled after 1 ms",
  healthy: true,
};

/** Run `fn` with a fake page tracer and health checks on globalThis. */
async function onFakePage<T>(
  tracer: PageTracer,
  fn: () => Promise<T>,
): Promise<T> {
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.capnpTracer = tracer;
  scope.capnpEngineHealth = () => Promise.resolve(healthyPage);
  try {
    return await fn();
  } finally {
    delete scope.capnpTracer;
    delete scope.capnpEngineHealth;
  }
}

/**
 * A page tracer whose workers' facts are folded from their events, and whose
 * posts are listed in order, as `[worker, post]`.
 */
function fakeTracer(
  workers: { events: string[]; terminated?: boolean }[],
  posts: [number, string][],
  from = longAgo(),
): PageTracer {
  const traced: TracedWorker[] = workers.map(({ events, terminated }) => ({
    events,
    terminated: terminated ?? false,
    facts: factsOf(events, from),
  }));
  return {
    workers: traced,
    posts: posts.map(([worker, post]) => ({
      worker,
      post,
      at: traced[worker].facts.posts[post] ?? from,
    })),
    drill: null,
  };
}

Deno.test("a stalled step's evidence is its latest unanswered message", async () => {
  const first = [
    "page:post:init:1",
    "0:started",
    "0:idle:start",
    "page:reply:1",
  ];
  const second = [
    "page:post:init:1",
    "0:started",
    "0:idle:start",
    "1:message:init:1",
    "2:reply:1",
    "2:idle:1",
    "page:reply:1",
    "page:post:compile:2",
    "page:terminate",
  ];
  const posts: [number, string][] = [[0, "init:1"], [1, "init:1"], [
    1,
    "compile:2",
  ]];
  const tracer = fakeTracer([{ events: first }, {
    events: second,
    terminated: true,
  }], posts);
  const evidence = await onFakePage(
    tracer,
    () => stepStallEvidence({ since: 1, error: "TimeoutError: x" }),
  );
  assert(
    evidence.expected === "compile:2" && evidence.worker === 1 &&
      evidence.posted === 2 && evidence.events.length === 9 &&
      evidence.error === "TimeoutError: x" && evidence.health.healthy &&
      evidence.count === null && evidence.answered === false &&
      evidence.facts?.posts["compile:2"] !== undefined &&
      evidence.facts.terminated !== null &&
      evidence.facts !== tracer.workers[1].facts &&
      evidence.at > evidence.facts.terminated,
    JSON.stringify(evidence),
  );
  // Posts before the step, and answered ones, are not the step's stall.
  const quiet = await onFakePage(
    tracer,
    () => stepStallEvidence({ since: 3, error: "TimeoutError: x" }),
  );
  assert(
    quiet.expected === null && quiet.worker === null && quiet.posted === 0 &&
      quiet.answered === false && quiet.facts === null &&
      quiet.events.length === 0,
    JSON.stringify(quiet),
  );
  // Every post answered at the page: the SDK's client did not settle, and
  // the evidence shows the last worker the step posted to.
  const answered = await onFakePage(
    fakeTracer([{ events: first }, {
      events: [
        ...second.slice(0, 8),
        "3:message:compile:2",
        "4:reply:2",
        "page:reply:2",
      ],
    }], posts),
    () => stepStallEvidence({ since: 1, error: "TimeoutError: x" }),
  );
  assert(
    answered.expected === null && answered.answered === true &&
      answered.posted === 2 && answered.events.at(-1) === "page:reply:2",
    JSON.stringify(answered),
  );
  assert(
    judgeStall(answered).because ===
      "every message the page posted during the step was answered at the page, yet the SDK's client did not settle",
    JSON.stringify(judgeStall(answered)),
  );
});

/** A fake StallRuleHost over a fake page, recording what the rule did. */
function fakeRuleHost(page: { tracer: PageTracer }) {
  const log: string[] = [];
  const host: StallRuleHost = {
    evaluate: <T, A>(fn: (argument: A) => T | Promise<T>, argument: A) =>
      onFakePage(page.tracer, async () => await fn(argument)),
    freshPage(label) {
      log.push(`fresh page for ${label}`);
      page.tracer = { workers: [], posts: [], drill: null };
      return Promise.resolve();
    },
    admit(kind, label, evidence: StepStallEvidence) {
      log.push(`admit ${kind} ${label} (${evidence.expected})`);
      return Promise.resolve();
    },
    tolerate(kind, label, evidence: StepStallEvidence, because) {
      log.push(`tolerate ${kind} ${label}: ${because} (${evidence.expected})`);
      return Promise.resolve();
    },
    stalledAgain(kind, label, _evidence, because, again, replaying) {
      log.push(
        `stalled again ${kind} ${label}: ${because}; ${again}${
          replaying ? " (replaying)" : ""
        }`,
      );
      return Promise.resolve();
    },
    beforeAttempt(label) {
      log.push(`arm ${label}`);
      return Promise.resolve();
    },
    afterAttempt(label) {
      log.push(`disarm ${label}`);
      return Promise.resolve();
    },
  };
  return { host, log };
}

/** A tracer where the page posted init to a worker whose script never ran. */
function neverStarted(): PageTracer {
  return fakeTracer([{
    events: ["page:post:init:1", "page:terminate"],
    terminated: true,
  }], [[0, "init:1"]]);
}

/** A tracer where the worker received init and never answered it. */
function neverAnswered(): PageTracer {
  return fakeTracer([{
    events: [
      "page:post:init:1",
      "0:started",
      "0:idle:start",
      "1:message:init:1",
      "page:terminate",
    ],
    terminated: true,
  }], [[0, "init:1"]]);
}

/** A tracer where the page posted init a moment ago to a worker not yet started. */
function justPosted(): PageTracer {
  return fakeTracer(
    [{ events: ["page:post:init:1"] }],
    [[0, "init:1"]],
    performance.now(),
  );
}

const timedOut = () =>
  Promise.reject(
    new Error("page.evaluate: TimeoutError: compilation timed out"),
  );

Deno.test("the stall rule retries an engine stall once, on a fresh page", async () => {
  // No stall: the result, nothing recorded.
  const idle = fakeRuleHost({ tracer: neverStarted() });
  assert(
    await underStallRule(
          idle.host,
          "resource-limits",
          "step",
          () => Promise.resolve(7),
        ) === 7 &&
      idle.log.join() === "arm step,disarm step",
    idle.log.join(),
  );
  // An engine stall: recorded, then retried on a fresh page.
  const page = {
    tracer: { workers: [], posts: [], drill: null } as PageTracer,
  };
  const engine = fakeRuleHost(page);
  let attempts = 0;
  const result = await underStallRule(
    engine.host,
    "resource-limits",
    "step",
    () => {
      attempts++;
      if (attempts === 1) {
        page.tracer = neverStarted();
        return timedOut();
      }
      return Promise.resolve("recovered");
    },
  );
  assert(
    result === "recovered" &&
      engine.log.join("; ") ===
        "arm step; disarm step; admit resource-limits step (init:1); fresh page for step; arm step; disarm step; tolerate resource-limits step: the engine never ran the worker's script (init:1)",
    engine.log.join("; "),
  );
});

Deno.test("the stall rule fails an SDK stall, a second stall, and a stall it cannot judge", async () => {
  // The worker received init and never answered: the SDK.
  const sdkPage = {
    tracer: { workers: [], posts: [], drill: null } as PageTracer,
  };
  const sdk = fakeRuleHost(sdkPage);
  const sdkFailure = await rejection(() =>
    underStallRule(sdk.host, "sdk-client", "load SDK", () => {
      sdkPage.tracer = neverAnswered();
      return timedOut();
    })
  );
  assert(
    sdkFailure.startsWith(
      "load SDK: the step stalled (TimeoutError: compilation timed out), and the evidence points at the SDK: the engine did its part and stayed healthy, yet the worker never answered init:1",
    ) && !sdk.log.some((entry) => entry.startsWith("tolerate")),
    `${sdkFailure} / ${sdk.log.join("; ")}`,
  );
  // An engine stall whose retry stalls too.
  const twicePage = {
    tracer: { workers: [], posts: [], drill: null } as PageTracer,
  };
  const twice = fakeRuleHost(twicePage);
  const twiceFailure = await rejection(() =>
    underStallRule(twice.host, "conformance-setup", "setup", () => {
      twicePage.tracer = neverStarted();
      return timedOut();
    })
  );
  assert(
    twiceFailure.startsWith(
      "setup: the step stalled again on a fresh page (TimeoutError: compilation timed out), after a stall that pointed at the engine (the engine never ran the worker's script)",
    ),
    twiceFailure,
  );
  // A stall that stalls again is reported as such, and never tolerated: no
  // ledger entry spends the budget on it.
  assert(
    twice.log.join("; ") ===
      "arm setup; disarm setup; admit conformance-setup setup (init:1); fresh page for setup; arm setup; disarm setup; stalled again conformance-setup setup: the engine never ran the worker's script; TimeoutError: compilation timed out",
    twice.log.join("; "),
  );
  // The budget: admit refuses, so the step fails without a retry and leaves
  // no ledger entry.
  const budgetPage = {
    tracer: { workers: [], posts: [], drill: null } as PageTracer,
  };
  const budget = fakeRuleHost(budgetPage);
  budget.host.admit = () =>
    Promise.reject(new Error("stall 2 of this job exceeds its budget of 1"));
  const budgetFailure = await rejection(() =>
    underStallRule(budget.host, "hostile-guests", "hostile", () => {
      budgetPage.tracer = neverStarted();
      return timedOut();
    })
  );
  assert(
    budgetFailure === "stall 2 of this job exceeds its budget of 1" &&
      !budget.log.some((entry) =>
        entry.startsWith("fresh page") || entry.startsWith("tolerate")
      ),
    `${budgetFailure} / ${budget.log.join("; ")}`,
  );
  // A page that cannot report its evidence.
  const lost = fakeRuleHost({ tracer: neverStarted() });
  const evaluate = lost.host.evaluate;
  lost.host.evaluate = (fn, argument, label, ms) =>
    label.endsWith("gather stall evidence")
      ? Promise.reject(
        new Error("Target page, context or browser has been closed"),
      )
      : evaluate(fn, argument, label, ms);
  const lostFailure = await rejection(() =>
    underStallRule(lost.host, "feature-rows", "row", timedOut)
  );
  assert(
    lostFailure ===
      "row: the step stalled (TimeoutError: compilation timed out), and the page did not report its evidence: Target page, context or browser has been closed",
    lostFailure,
  );
  // A step deadline a moment after the post: slowness, not a stall.
  const slowPage = {
    tracer: { workers: [], posts: [], drill: null } as PageTracer,
  };
  const slow = fakeRuleHost(slowPage);
  const slowFailure = await rejection(() =>
    underStallRule(slow.host, "feature-rows", "row", () => {
      slowPage.tracer = justPosted();
      return Promise.reject(new DeadlineError("webkit row", 60_000));
    })
  );
  assert(
    /^row: the step stalled \(TimeoutError: no progress: webkit row did not finish within 60 seconds\), and the evidence shows slowness rather than a stall: the worker had not started, and the latest progress was only [0-9]+ ms before the stall: /
      .test(slowFailure) &&
      !slow.log.some((entry) =>
        entry.startsWith("tolerate") || entry.startsWith("fresh page")
      ),
    `${slowFailure} / ${slow.log.join("; ")}`,
  );
  // Any other failure is the step's own.
  const other = fakeRuleHost({ tracer: neverStarted() });
  const otherFailure = await rejection(() =>
    underStallRule(
      other.host,
      "feature-rows",
      "row",
      () =>
        Promise.reject(new Error("page.evaluate: CompileError: cpp trapped")),
    )
  );
  assert(
    otherFailure === "page.evaluate: CompileError: cpp trapped",
    otherFailure,
  );
});

Deno.test("a result that shows a timeout its expectation refuses is a stall", async () => {
  const page = {
    tracer: { workers: [], posts: [], drill: null } as PageTracer,
  };
  const rows = fakeRuleHost(page);
  let attempts = 0;
  const result = await underStallRule(
    rows.host,
    "conformance-rows",
    "row",
    () => {
      attempts++;
      if (attempts === 1) page.tracer = neverStarted();
      return Promise.resolve(attempts === 1 ? "timeout" : "ok");
    },
    (outcome) =>
      outcome === "timeout" ? "TimeoutError: the row timed out" : null,
  );
  assert(
    result === "ok" &&
      rows.log.some((entry) =>
        entry.startsWith("tolerate conformance-rows row:")
      ),
    `${result} / ${rows.log.join("; ")}`,
  );
});

Deno.test("a stalled step's ledger entry names the step, and warns in one line", () => {
  const stall: SoakStall = {
    job: "local",
    engine: "webkit",
    os: "linux",
    kind: "conformance-setup",
    mode: "webkit load the conformance runner and the Studio adapter",
    at: new Date(0).toISOString(),
    summary:
      "TimeoutError: compilation timed out; the engine never ran the worker's script",
    detail: null,
  };
  assert(
    stallTitle(stall) === "Worker stall" &&
      stallPlace(stall) ===
        "webkit load the conformance runner and the Studio adapter (conformance-setup)",
    `${stallTitle(stall)} / ${stallPlace(stall)}`,
  );
  const warning = stallWarning(stall);
  assert(
    warning ===
      "::warning title=Worker stall (webkit)::webkit load the conformance runner and the Studio adapter (conformance-setup): TimeoutError: compilation timed out; the engine never ran the worker's script",
    warning,
  );
});

Deno.test("the page tracer keeps every fact past its display ring", async () => {
  // The tracer init script, run over a fake Worker: each fake worker's trace
  // and replies are dispatched as the real worker's messages would be.
  class FakeWorker extends EventTarget {
    constructor(readonly url: string | URL, readonly options?: WorkerOptions) {
      super();
    }
    postMessage(_message: unknown, _transfer?: unknown) {}
    terminate() {}
  }
  const page: Record<string, unknown> = { Worker: FakeWorker };
  new Function("globalThis", "location", workerTracerScript)(page, {
    href: "http://driver.test/",
  });
  const tracer = page.capnpTracer as PageTracer;
  const PageWorker = page.Worker as new (
    url: string,
    options: WorkerOptions,
  ) => FakeWorker;
  // A long-lived client: init, then 12 generate jobs of 4 instantiations
  // each, then generate:13, which the engine never delivers. `held` leaves
  // out the worker's last idle event, as SDK code holding its thread would.
  const client = (held: boolean) => {
    const worker = new PageWorker("worker.js", { type: "module" });
    const say = (event: string) =>
      worker.dispatchEvent(
        new MessageEvent("message", {
          data: { kind: "capnpTrace", event, t: 0 },
        }),
      );
    const answer = (id: number, last = false) => {
      worker.dispatchEvent(
        new MessageEvent("message", { data: { id, result: null } }),
      );
      say(`reply:${id}`);
      if (!(last && held)) say(`idle:${id}`);
    };
    worker.postMessage({ kind: "init", id: 1 });
    say("started");
    say("idle:start");
    say("message:init:1");
    say("compile1:start:10");
    say("compile1:end");
    answer(1);
    for (let id = 2; id <= 12; id++) {
      worker.postMessage({ kind: "generate", id });
      say(`message:generate:${id}`);
      for (let n = 1; n <= 4; n++) {
        say(`instantiate${id * 4 + n}:start`);
        say(`instantiate${id * 4 + n}:end`);
      }
      answer(id, id === 12);
    }
    const since = tracer.posts.length;
    worker.postMessage({ kind: "generate", id: 13 });
    return { since, traced: tracer.workers.at(-1)! };
  };
  const idle = client(false);
  assert(
    idle.traced.events.length <= 60 &&
      !idle.traced.events.includes("0:started") &&
      !idle.traced.events.includes("0:message:init:1"),
    `the display ring kept ${idle.traced.events.length} events`,
  );
  assert(
    idle.traced.facts.started !== null &&
      Object.keys(idle.traced.facts.received).length === 12 &&
      Object.keys(idle.traced.facts.replied).length === 12 &&
      Object.keys(idle.traced.facts.pageReplies).length === 12 &&
      Object.keys(idle.traced.facts.posts).length === 13 &&
      Object.keys(idle.traced.facts.open).length === 0 &&
      idle.traced.facts.busySince === null,
    `facts lost past the ring: ${JSON.stringify(idle.traced.facts)}`,
  );
  // Judged after the floor, as a stall 10 s later would be.
  const later = (evidence: StallEvidence) => ({
    ...evidence,
    at: evidence.at + 10_000,
  });
  const idleEvidence = await onFakePage(
    tracer,
    () => stepStallEvidence({ since: idle.since, error: "TimeoutError: x" }),
  );
  const idleJudged = judgeStall(later(idleEvidence));
  assert(
    idleEvidence.expected === "generate:13" && idleEvidence.worker === 0 &&
      idleJudged.suspect === "engine" &&
      idleJudged.because ===
        "the engine never delivered generate:13 to the idle worker",
    JSON.stringify(idleJudged),
  );
  const held = client(true);
  const heldEvidence = await onFakePage(
    tracer,
    () => stepStallEvidence({ since: held.since, error: "TimeoutError: x" }),
  );
  const heldJudged = judgeStall(later(heldEvidence));
  assert(
    heldEvidence.worker === 1 && heldJudged.suspect === "sdk" &&
      heldJudged.because ===
        "the worker never returned to its event loop after answering 12: its own code held its thread or kept the trace's idle timer from running, so it never took generate:13",
    JSON.stringify(heldJudged),
  );
  // terminate() is an ordered page event, and a later post is the SDK's.
  const worker = new PageWorker("worker.js", { type: "module" });
  worker.terminate();
  worker.postMessage({ kind: "init", id: 1 });
  const ended = tracer.workers[2];
  assert(
    ended.terminated &&
      ended.events.join() === "page:terminate,page:post:init:1" &&
      ended.facts.terminated !== null &&
      judgeStall(later(evidenceOf("init:1", ended.facts))).because ===
        "the page posted init:1 to a worker it had terminated",
    JSON.stringify(ended),
  );
});

/**
 * Run a module worker whose script imports the trace module first and then
 * runs `body`, post it `messages`, and collect what the page would see: its
 * trace events as `<ms>:<event>` and each other message with an id as
 * `page:reply:<id>`, until `done` holds (at most 10 s).
 */
async function traceInWorker(
  body: string,
  messages: unknown[],
  done: (seen: string[]) => boolean,
): Promise<string[]> {
  const blob = (source: string) =>
    URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const traceURL = blob(traceModuleSource);
  const workerURL = blob(`import "${traceURL}";\n${body}`);
  const worker = new Worker(workerURL, { type: "module" });
  const seen: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`the trace did not finish in 10 s: ${seen.join()}`)),
        10_000,
      );
      worker.onmessage = ({ data }) => {
        seen.push(
          data?.kind === "capnpTrace"
            ? `${data.t}:${data.event}`
            : `page:reply:${String(data?.id)}`,
        );
        if (done(seen)) resolve();
      };
      worker.onerror = (event) => {
        event.preventDefault();
        reject(new Error(event.message));
      };
      for (const message of messages) worker.postMessage(message);
    });
  } finally {
    clearTimeout(timer);
    worker.terminate();
    URL.revokeObjectURL(traceURL);
    URL.revokeObjectURL(workerURL);
  }
  return seen;
}

/** A trace event's name, without its time. */
const named = (event: string) =>
  event.startsWith("page:") ? event : event.slice(event.indexOf(":") + 1);

Deno.test("the trace module reports a start section, each reply once posted, and idle after its activity", async () => {
  const plain = "0061736d01000000010401600000030201000a040102000b";
  // The same module with a start section (id 8) naming its function.
  const started = "0061736d0100000001040160000003020100080100" + "0a040102000b";
  const seen = (await traceInWorker(
    `const bytes = (hex) => Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
self.onmessage = async ({ data }) => {
  const module = await WebAssembly.compile(bytes("${started}"));
  await WebAssembly.instantiate(module, {});
  await WebAssembly.instantiate(bytes("${plain}"), {});
  self.postMessage({ id: data.id, result: "done" });
};`,
    [{ kind: "job", id: 7 }],
    (seen) =>
      seen.some((event) => named(event) === "reply:7") &&
      named(seen.at(-1)!) === "idle",
  )).map(named);
  const order = [
    "started",
    "message:job:7",
    `compile1:start:${started.length / 2}`,
    "compile1:end",
    "instantiate1:start:runs-start",
    "instantiate1:end",
    "instantiate2:start",
    "instantiate2:end",
    "page:reply:7",
    "reply:7",
    "idle",
  ];
  let from = 0;
  const at = order.map((event) => (from = seen.indexOf(event, from) + 1) - 1);
  assert(
    at.every((index) => index >= 0) &&
      seen.indexOf("idle") > seen.indexOf("started") &&
      seen.some((event) => /^task:start:[0-9]+:onmessage handler$/.test(event)),
    `trace: ${seen.join()}`,
  );
  // The handler's task ends; every task the trace opened is closed.
  const begun = seen.filter((event) => event.startsWith("task:start:")).map(
    (event) => event.split(":")[2],
  );
  const ended = seen.filter((event) => event.startsWith("task:end:")).map(
    (event) => event.split(":")[2],
  );
  assert(
    begun.length > 0 && begun.every((n) => ended.includes(n)),
    `tasks: ${seen.join()}`,
  );
});

Deno.test("the trace shows the worker's own code holding its thread, whatever task source ran it", async () => {
  const hold = "{ const end = Date.now() + 400; while (Date.now() < end) {} }";
  const answer = "self.postMessage({ id: data.id });";
  const cases: [string, string, RegExp][] = [
    // R3: a timer callback queued after the reply runs after the idle marker.
    [
      "a timer callback",
      `self.onmessage = ({ data }) => { ${answer} setTimeout(() => ${hold}, 0); };`,
      /^task:start:[0-9]+:timer callback$/,
    ],
    [
      "an interval callback",
      `self.onmessage = ({ data }) => { ${answer} const n = setInterval(() => { clearInterval(n); ${hold} }, 0); };`,
      /^task:start:[0-9]+:interval callback$/,
    ],
    [
      "a microtask",
      `self.onmessage = ({ data }) => { ${answer} queueMicrotask(() => ${hold}); };`,
      /^task:start:[0-9]+:microtask$/,
    ],
    [
      "a message listener",
      `self.addEventListener("message", ({ data }) => { ${answer} ${hold} });`,
      /^task:start:[0-9]+:message listener$/,
    ],
  ];
  for (const [what, body, holding] of cases) {
    const seen = await traceInWorker(
      body,
      [{ kind: "job", id: 1 }],
      (seen) =>
        seen.some((event) => holding.test(named(event))) &&
        named(seen.at(-1)!) === "idle",
    );
    // The page's view while the callback held the thread: everything before
    // its task:end, then a job the worker never took.
    const start = seen.findIndex((event) => holding.test(named(event)));
    const task = named(seen[start]).split(":")[2];
    const end = seen.findIndex((event) => named(event) === `task:end:${task}`);
    const during = [...seen.slice(0, end), "page:post:job:2"];
    const judged = judgeStall(evidenceOf("job:2", factsOf(during)));
    assert(
      judged.suspect === "sdk" &&
        judged.because ===
          `the worker's own code held its thread in its ${
            named(seen[start]).split(":").slice(3).join(":")
          } (task ${task}), so it never took job:2`,
      `${what}: ${JSON.stringify(judged)} from ${during.join()}`,
    );
    // The task ends and the worker goes idle again.
    assert(
      end > start &&
        seen.slice(end).some((event) => named(event) === "idle"),
      `${what}: ${seen.join()}`,
    );
  }
});

Deno.test("the trace shows a worker that closed itself, and keeps its idle marker when the worker's code replaces its timers", async () => {
  // R5: the worker closes itself in a timer callback after its reply.
  const closed = await traceInWorker(
    `self.onmessage = ({ data }) => { self.postMessage({ id: data.id }); setTimeout(() => self.close(), 0); };`,
    [{ kind: "job", id: 1 }],
    (seen) => seen.some((event) => named(event) === "close"),
  );
  const judged = judgeStall(
    evidenceOf("job:2", factsOf([...closed, "page:post:job:2"])),
  );
  assert(
    judged.suspect === "sdk" &&
      judged.because ===
        "the worker closed itself (self.close()) and never answered job:2",
    `${JSON.stringify(judged)} from ${closed.join()}`,
  );
  // R4: the worker's code replaces its timers after the reply; the trace's
  // own timer still says idle.
  const replaced = await traceInWorker(
    `self.onmessage = ({ data }) => {
  self.setTimeout = () => 0;
  self.setInterval = () => 0;
  self.queueMicrotask = () => {};
  self.postMessage({ id: data.id });
};`,
    [{ kind: "job", id: 1 }],
    (seen) =>
      seen.some((event) => named(event) === "reply:1") &&
      named(seen.at(-1)!) === "idle",
  );
  const idle = judgeStall(
    evidenceOf("job:2", factsOf([...replaced, "page:post:job:2"])),
  );
  assert(
    idle.suspect === "engine" &&
      idle.because === "the engine never delivered job:2 to the idle worker",
    `${JSON.stringify(idle)} from ${replaced.join()}`,
  );
});

Deno.test("the floor scales with the wait that caught a stall", () => {
  assert(
    stallFloorFor(60_000) === stallFloorMs && stallFloorFor(2_018) === 1_513 &&
      stallFloorFor(5_000) === 3_750,
    "stallFloorFor",
  );
  assert(
    stallFloorOf(new DeadlineError("webkit row", 5_000)) === 3_750 &&
      stallFloorOf(new DeadlineError("webkit row", 60_000)) === stallFloorMs &&
      stallFloorOf(
          new Error("page.evaluate: TimeoutError: compilation timed out"),
        ) === undefined,
    "stallFloorOf",
  );
  // The review's probe 5: a worker that never started, its post 3 s before a
  // 60 s step deadline, is slowness; 4 s before a 5 s deadline, a stall.
  const deadline = (ms: number) =>
    `TimeoutError: no progress: webkit load SDK did not finish within ${
      ms / 1000
    } seconds`;
  const late = judgeStall(
    evidenceOf(
      "init:1",
      factsAgo([[3_000, "page:post:init:1"]]),
      deadline(60_000),
    ),
    { floorMs: stallFloorFor(60_000) },
  );
  const stuck = judgeStall(
    evidenceOf(
      "init:1",
      factsAgo([[4_000, "page:post:init:1"]]),
      deadline(5_000),
    ),
    { floorMs: stallFloorFor(5_000) },
  );
  assert(
    late.suspect === "slow" && stuck.suspect === "engine" &&
      stuck.because === "the engine never ran the worker's script",
    `${JSON.stringify(late)} / ${JSON.stringify(stuck)}`,
  );
});

Deno.test("a timeout sample's start stall is judged on its own floor, and a cancelled job's reply does not hide a late guest", () => {
  // A probe worker that answered init and went idle; its job posted just
  // after, 2,018 ms before the evidence at the sample's 2 s deadline.
  const served: [number, string][] = [
    [2_030, "page:post:init:1"],
    [2_028, "0:started"],
    [2_027, "1:message:init:1"],
    [2_025, "2:compile1:start:145"],
    [2_024, "2:idle"],
    [2_023, "3:compile1:end"],
    [2_021, "page:reply:1"],
    [2_019, "4:reply:1"],
    [2_018, "page:post:compile:2"],
    [2_017, "5:idle"],
  ];
  const timedOut = "TimeoutError: the job stopped";
  // Drill T1: the engine never delivered the job before the deadline.
  const t1 = evidenceOf("compile:2", factsAgo(served), timedOut);
  const onFloor = judgeStall(t1, { floorMs: stallFloorFor(2_018) });
  const unscaled = judgeStall(t1);
  assert(
    onFloor.suspect === "engine" &&
      onFloor.because ===
        "the engine never delivered compile:2 to the idle worker" &&
      unscaled.suspect === "slow",
    `${JSON.stringify(onFloor)} / ${JSON.stringify(unscaled)}`,
  );
  // The review's probe 3: the job arrived late, the guest ran a few ms, the
  // deadline stopped it, and the cancellation reached the page first.
  const late = factsAgo([
    ...served,
    [100, "2000:message:compile:2"],
    [95, "2005:instantiate1:start"],
    [93, "2007:instantiate1:end"],
    [48, "2052:reply:2:error"],
    [47, "page:reply:2"],
    [46, "2054:idle"],
  ]);
  const ranLate = judgeStall(
    { ...evidenceOf("compile:2", late, timedOut), count: 3 },
    { floorMs: stallFloorFor(2_018) },
  );
  assert(
    ranLate.suspect === "engine" &&
      ranLate.because === "the guest ran, only late",
    JSON.stringify(ranLate),
  );
  // A step's job that ran until the SDK's own timeout cancelled it: the job
  // did not finish, not the engine.
  const step = judgeStall(evidenceOf("compile:2", late, timedOut));
  assert(
    step.suspect === "sdk" &&
      step.because ===
        "compile:2 ran until the SDK's own timeout stopped it, and the worker answered with the cancellation: the job, not the engine, did not finish",
    JSON.stringify(step),
  );
  // A step deadline is no cancellation: the reply reached the page, and the
  // client did not settle.
  const deadline = judgeStall(
    evidenceOf(
      "compile:2",
      late,
      "TimeoutError: no progress: webkit row did not finish within 60 seconds",
    ),
  );
  assert(
    deadline.suspect === "sdk" &&
      deadline.because ===
        "the worker's reply to compile:2 reached the page, yet the SDK's client did not settle",
    JSON.stringify(deadline),
  );
});

Deno.test("both page scripts count a reply with any id, and count the page's workers", () => {
  class FakeWorker extends EventTarget {
    constructor(readonly url: string | URL, readonly options?: WorkerOptions) {
      super();
    }
    postMessage(_message: unknown, _transfer?: unknown) {}
    terminate() {}
  }
  const say = (worker: FakeWorker, data: unknown) =>
    worker.dispatchEvent(new MessageEvent("message", { data }));
  const trace = (worker: FakeWorker, event: string) =>
    say(worker, { kind: "capnpTrace", event, t: 0 });
  for (const script of ["tracer", "audit"] as const) {
    const page: Record<string, unknown> = { Worker: FakeWorker };
    if (script === "tracer") {
      new Function("globalThis", "location", workerTracerScript)(page, {
        href: "http://driver.test/",
      });
    } else new Function("globalThis", workerAuditScript)(page);
    const PageWorker = page.Worker as new (
      url: string,
      options: WorkerOptions,
    ) => FakeWorker;
    const factsOfPage = () =>
      script === "tracer"
        ? (page.capnpTracer as PageTracer).workers.map((worker) => worker.facts)
        : (page.capnpWorkerAudit as { facts: WorkerFacts[] }).facts;
    const compiled = new PageWorker("worker.js", { type: "module" });
    compiled.postMessage({ kind: "compile", id: "a" });
    trace(compiled, "started");
    trace(compiled, "message:compile:a");
    trace(compiled, "compile1:start:1000");
    trace(compiled, "compile1:end");
    say(compiled, { id: "a", result: null });
    trace(compiled, "reply:a");
    const ended = new PageWorker("worker.js", { type: "module" });
    trace(ended, "compile1:start:500");
    trace(ended, "compile1:end");
    ended.terminate();
    const closed = new PageWorker("worker.js", { type: "module" });
    trace(closed, "compile1:start:700");
    trace(closed, "compile1:end");
    trace(closed, "close");
    const facts = factsOfPage();
    const counted = (page.capnpPageWorkers as () => unknown)();
    assert(
      facts[0].pageReplies["a"] !== undefined &&
        facts[0].replied["a"] !== undefined && facts[0].compiledBytes === 1000,
      `${script}: ${JSON.stringify(facts[0])}`,
    );
    assert(
      JSON.stringify(counted) ===
        JSON.stringify({ created: 3, live: 1, liveWasmBytes: 1000 }),
      `${script}: ${JSON.stringify(counted)}`,
    );
  }
});

Deno.test("the stall rule's retry replays the step's client history first", async () => {
  const page = {
    tracer: { workers: [], posts: [], drill: null } as PageTracer,
  };
  const replayed = fakeRuleHost(page);
  let attempts = 0;
  const result = await underStallRule(
    replayed.host,
    "feature-rows",
    "row",
    () => {
      attempts++;
      replayed.log.push(`attempt ${attempts}`);
      if (attempts === 1) {
        page.tracer = neverStarted();
        return timedOut();
      }
      return Promise.resolve("recovered");
    },
    undefined,
    () => {
      replayed.log.push("replay the client's history");
      return Promise.resolve();
    },
  );
  assert(
    result === "recovered" &&
      replayed.log.join("; ") ===
        "arm row; attempt 1; disarm row; admit feature-rows row (init:1); fresh page for row; replay the client's history; arm row; attempt 2; disarm row; tolerate feature-rows row: the engine never ran the worker's script (init:1)",
    replayed.log.join("; "),
  );
  // A stall while the history replays is a second stall.
  const againPage = {
    tracer: { workers: [], posts: [], drill: null } as PageTracer,
  };
  const again = fakeRuleHost(againPage);
  const replayStall = await rejection(() =>
    underStallRule(
      again.host,
      "feature-rows",
      "row",
      () => {
        againPage.tracer = neverStarted();
        return timedOut();
      },
      undefined,
      () =>
        Promise.reject(
          new Error("page.evaluate: TimeoutError: generation timed out"),
        ),
    )
  );
  assert(
    replayStall.startsWith(
      "row: the step stalled again on a fresh page, while it replayed its clients' history (TimeoutError: generation timed out), after a stall that pointed at the engine (the engine never ran the worker's script)",
    ),
    replayStall,
  );
  // A fault the client's history causes recurs on the retry, whatever the
  // first stall was judged: its replay gives the client the same history.
  const poisoned = {
    tracer: { workers: [], posts: [], drill: null } as PageTracer,
  };
  const history = fakeRuleHost(poisoned);
  let clientHistory: string[] = ["generic-rpc"];
  history.host.freshPage = (label) => {
    history.log.push(`fresh page for ${label}`);
    poisoned.tracer = { workers: [], posts: [], drill: null };
    clientHistory = [];
    return Promise.resolve();
  };
  const recurs = await rejection(() =>
    underStallRule(
      history.host,
      "feature-rows",
      "replay generic-rpc",
      () => {
        if (!clientHistory.includes("generic-rpc")) {
          return Promise.resolve("no fault");
        }
        // Judged as the engine's on the first attempt: the worker never ran.
        poisoned.tracer = neverStarted();
        return timedOut();
      },
      undefined,
      () => {
        clientHistory.push("generic-rpc");
        return Promise.resolve();
      },
    )
  );
  assert(
    recurs.startsWith(
      "replay generic-rpc: the step stalled again on a fresh page (TimeoutError: compilation timed out)",
    ),
    recurs,
  );
  // A step deadline judges with a floor scaled to it: a worker that never
  // started for 4 s of a 5 s deadline is a stall, not slowness.
  const shortPage = {
    tracer: { workers: [], posts: [], drill: null } as PageTracer,
  };
  const short = fakeRuleHost(shortPage);
  let tries = 0;
  const shortResult = await underStallRule(
    short.host,
    "sdk-client",
    "load SDK",
    () => {
      tries++;
      if (tries > 1) return Promise.resolve("loaded");
      shortPage.tracer = fakeTracer(
        [{ events: ["page:post:init:1"] }],
        [[0, "init:1"]],
        performance.now() - 4_000,
      );
      return Promise.reject(new DeadlineError("load SDK", 5_000));
    },
  );
  assert(
    shortResult === "loaded" &&
      short.log.some((entry) =>
        entry.startsWith(
          "tolerate sdk-client load SDK: the engine never ran the worker's script",
        )
      ),
    short.log.join("; "),
  );
});

Deno.test("a conformance row's history is the rows its client ran before it", async () => {
  const rows: [string, string][] = [
    ["a1", "a"],
    ["a2", "a"],
    ["b1", "b"],
    ["a3", "a"],
  ];
  /** Which earlier rows each row's replay runs, on one surface. */
  const replayedBy = async (surface: string) => {
    const history = clientHistory(surface);
    const log: string[] = [];
    const replays: Record<string, () => Promise<void>> = {};
    for (const [name, compiler] of rows) {
      replays[name] = history.before(
        { name, compiler, generators: ["cpp"] } as unknown as Parameters<
          typeof history.before
        >[0],
      );
      history.ran(() => {
        log.push(name);
        return Promise.resolve();
      });
    }
    const replayed: Record<string, string> = {};
    for (const [name, replay] of Object.entries(replays)) {
      log.length = 0;
      await replay();
      replayed[name] = log.join(",");
    }
    return replayed;
  };
  // cachingHost keeps one client per configuration: b1 replaces a's client,
  // and a3 starts a new one.
  const cached = await replayedBy("browser-worker");
  assert(
    JSON.stringify(cached) ===
      JSON.stringify({ a1: "", a2: "a1", b1: "", a3: "" }),
    `browser-worker: ${JSON.stringify(cached)}`,
  );
  // The Studio surface runs every row on one adapter.
  const studio = await replayedBy("studio");
  assert(
    JSON.stringify(studio) ===
      JSON.stringify({ a1: "", a2: "a1", b1: "a1,a2", a3: "a1,a2,b1" }),
    `studio: ${JSON.stringify(studio)}`,
  );
});

Deno.test("a 2 s timeout sample whose job the engine never delivered is retried and tolerated (drill T1)", async () => {
  // The probe worker answered init and went idle; its job was posted just
  // after, and the page took the evidence at the 2 s deadline.
  const facts = factsAgo([
    [2_030, "page:post:init:1"],
    [2_028, "0:started"],
    [2_027, "1:message:init:1"],
    [2_021, "page:reply:1"],
    [2_019, "4:reply:1"],
    [2_018, "page:post:compile:2"],
    [2_017, "5:idle"],
  ]);
  const stall: StartStall = {
    stage: "start",
    reason:
      "the guest did not run for a 50 ms window before its 2000 ms deadline",
    afterMs: 2_018,
    expected: "compile:2",
    error: "TimeoutError: the job stopped",
    events: [],
    count: 0,
    health: healthy,
    facts,
    at: performance.now(),
  };
  let left = 1;
  const tolerated: string[] = [];
  const result = await checkIsolatedTermination(
    "webkit",
    engineThat(
      () => 50,
      (sample) =>
        sample.guest === "pure" && sample.mode === "timeout" && left-- > 0
          ? { stall }
          : {},
    ),
    "linux",
    (label, tolerable) => {
      tolerated.push(`${label}: ${tolerable.stage}`);
      return Promise.resolve();
    },
  );
  assert(
    result.verdict.startsWith("PASS webkit") &&
      tolerated.join() === "webkit isolated termination pure timeout: start",
    `tolerated ${tolerated.join()}: ${result.verdict}`,
  );
});

Deno.test("the trace runs the handler properties of every EventTarget type as tasks", async () => {
  // A hold in FileReader's onload, as one in IDBRequest's onsuccess would be:
  // a handler property of an EventTarget type other than the worker's own.
  const hold = "{ const end = Date.now() + 400; while (Date.now() < end) {} }";
  const seen = await traceInWorker(
    `self.onmessage = ({ data }) => {
  self.postMessage({ id: data.id });
  const reader = new FileReader();
  reader.onload = () => ${hold};
  reader.readAsArrayBuffer(new Blob([new Uint8Array(1)]));
};`,
    [{ kind: "job", id: 1 }],
    (seen) =>
      seen.some((event) =>
        /^task:end:[0-9]+$/.test(named(event)) &&
        seen.some((other) => /:onload handler$/.test(named(other)))
      ) && named(seen.at(-1)!) === "idle",
  );
  const start = seen.findIndex((event) =>
    /^task:start:[0-9]+:onload handler$/.test(named(event))
  );
  assert(start >= 0, `no onload task: ${seen.join()}`);
  const task = named(seen[start]).split(":")[2];
  const end = seen.findIndex((event) => named(event) === `task:end:${task}`);
  const judged = judgeStall(
    evidenceOf("job:2", factsOf([...seen.slice(0, end), "page:post:job:2"])),
  );
  assert(
    judged.suspect === "sdk" &&
      judged.because ===
        `the worker's own code held its thread in its onload handler (task ${task}), so it never took job:2`,
    `${JSON.stringify(judged)} from ${seen.join()}`,
  );
});
