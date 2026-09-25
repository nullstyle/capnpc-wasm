// The termination verdicts without a browser: a fake page evaluator returns
// the samples a real engine would, so each check in termination.ts is
// exercised on every host, and measureTermination's own page function runs
// here against a fake SDK. Also the recovery soak's stall budget and warnings
// (soak-stalls.ts). Runs in test:browser-bootstrap.
import {
  checkIsolatedTermination,
  checkPlainTermination,
  measureTermination,
  type TerminationGuest,
  type TerminationMode,
  type TerminationSample,
} from "./termination.ts";
import {
  type SoakStall,
  stallBudget,
  stallJob,
  stallWarning,
} from "./soak-stalls.ts";

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

/**
 * Run measureTermination's page function here, against a fake SDK whose
 * guest counts every 10 ms in shared memory until `stopAfterMs` after its job
 * is rejected.
 */
async function measureFake(
  stopAfterMs: number,
  mode: TerminationMode,
): Promise<TerminationSample> {
  const counter = new Int32Array(new SharedArrayBuffer(4));
  let stopAt = Infinity;
  const ticker = setInterval(() => {
    if (performance.now() < stopAt) Atomics.add(counter, 0, 1);
  }, 10);
  const audit = {
    created: 0,
    terminated: 0,
    probes: [] as (Int32Array | null)[],
  };
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.capnpWorkerAudit = audit;
  scope.capnpTermination = {
    sdk: {
      createWorkerCompiler() {
        audit.created++;
        audit.probes.push(counter);
        return Promise.resolve({
          compile(
            _job: unknown,
            options: { signal?: AbortSignal; timeoutMs?: number } = {},
          ) {
            return new Promise((_resolve, reject) => {
              const stop = (name: string) => {
                clearTimeout(timer);
                stopAt = Math.min(stopAt, performance.now() + stopAfterMs);
                reject(new DOMException("the job stopped", name));
              };
              const timer = setTimeout(
                () => stop("TimeoutError"),
                options.timeoutMs ?? 30_000,
              );
              options.signal?.addEventListener(
                "abort",
                () => stop("AbortError"),
              );
            });
          },
          dispose() {},
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
    return await measureTermination(local, "pure", mode, "fake guest");
  } finally {
    clearInterval(ticker);
    delete scope.capnpWorkerAudit;
    delete scope.capnpTermination;
  }
}

Deno.test("measureTermination sees a stop just inside the bound, and one that never comes", async () => {
  // Quiet for a second only at 2.2 s: a window of the bound alone would miss it.
  const late = await measureFake(1_200, "timeout");
  assert(
    late.stoppedAfterMs !== null && late.stoppedAfterMs >= 1_100 &&
      late.stoppedAfterMs <= 1_400,
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
});
