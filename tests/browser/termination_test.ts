// The termination verdicts without a browser: a fake page evaluator returns
// the samples a real engine would, so each check in termination.ts is
// exercised on every host. Runs in test:browser-bootstrap.
import {
  checkIsolatedTermination,
  checkPlainTermination,
  type TerminationGuest,
  type TerminationMode,
  type TerminationSample,
} from "./termination.ts";

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
