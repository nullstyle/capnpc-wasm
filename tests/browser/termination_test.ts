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
} from "./termination.ts";
import {
  type EngineHealth,
  judgeStall,
  type StallEvidence,
  stallSuspect,
} from "./worker-trace.ts";
import {
  type SoakStall,
  stallBudget,
  stallJob,
  stallWarning,
} from "./soak-stalls.ts";
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
  const audit = {
    created: 0,
    terminated: 0,
    probes: [] as (Int32Array | null)[],
    traces: [] as string[][],
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
        events.push("page:post:init:1", "0:started", "1:message:init:1");
        if (fake.initFails) {
          return Promise.reject(
            new DOMException("compilation timed out", "TimeoutError"),
          );
        }
        if (fake.initError) return Promise.reject(fake.initError);
        events.push("2:reply:1", "page:reply:1");
        audit.probes.push(counter);
        return Promise.resolve({
          compile(
            _job: unknown,
            options: { signal?: AbortSignal; timeoutMs?: number } = {},
          ) {
            events.push("page:post:compile:2", "3:message:compile:2");
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
  const post = events.filter((event) => event.startsWith(`page:post:${kind}:`))
    .at(-1);
  return {
    stage,
    reason: `the probe worker did not ${stage}`,
    afterMs: 10_000,
    expected: post === undefined ? null : post.slice("page:post:".length),
    error,
    events,
    count,
    health,
  };
}

Deno.test("A start stall points at the SDK only where the engine did its part", () => {
  const initialized = [
    "page:post:init:1",
    "0:started",
    "1:message:init:1",
    "1:compile1:start:73",
    "2:compile1:end",
  ];
  const instantiated = [
    ...initialized,
    "3:reply:1",
    "page:reply:1",
    "page:post:compile:2",
    "4:message:compile:2",
    "5:instantiate1:start",
    "6:instantiate1:end",
  ];
  const cases: [string, StartStall, "sdk" | "engine"][] = [
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
      "an init message never delivered",
      startStall("init", ["page:post:init:1", "0:started"]),
      "engine",
    ],
    [
      "a compile that never finished",
      startStall("init", initialized.slice(0, 4)),
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
      "a job never delivered",
      startStall("start", instantiated.slice(0, 8), 0),
      "engine",
    ],
    [
      "an instantiation that never finished",
      startStall("start", instantiated.slice(0, 10), 0),
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
  });
  const received = [
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
      soak("compile:9", [...received.slice(0, 2), "41:compile3:start:5"]),
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
  ];
  for (const [label, evidence, suspect, because] of cases) {
    const judged = judgeStall(evidence);
    assert(
      judged.suspect === suspect && judged.because === because,
      `${label}: read as ${JSON.stringify(judged)}`,
    );
  }
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
