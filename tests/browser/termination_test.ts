// The termination verdicts without a browser: a fake page evaluator returns
// the samples a real engine would, so each branch of checkIsolatedTermination
// is exercised on every host. Runs in test:browser-bootstrap.
import {
  checkIsolatedTermination,
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

/** An evaluator whose guests stop after `stops(guest)` ms, or never (null). */
function engineThat(stops: (guest: TerminationGuest) => number | null) {
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
      atRejection: 20,
      final: 30,
      rejection: { name: rejections[mode], message: "" },
      rejectionAfterMs: 5,
      stoppedAfterMs: stops(guest),
      terminateCalls: 1,
      workersCreated: 1,
    };
    return Promise.resolve(sample as unknown as T);
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

const webkitMeasured = engineThat((guest) => guest === "pure" ? null : 150);

Deno.test("macOS WebKit: a pure-Wasm guest that keeps running is the expected failure", async () => {
  const result = await checkIsolatedTermination(
    "webkit",
    webkitMeasured,
    "darwin",
  );
  assert(
    result.verdict.startsWith("EXPECTED FAILURE webkit on darwin"),
    result.verdict,
  );
});

Deno.test("macOS WebKit: a pure-Wasm guest that stops fails loudly", async () => {
  const message = await rejection(() =>
    checkIsolatedTermination("webkit", engineThat(() => 150), "darwin")
  );
  assert(message.includes("no longer holds"), message);
});

Deno.test("Linux WebKit: either pure-Wasm behavior passes and is reported", async () => {
  const running = await checkIsolatedTermination(
    "webkit",
    webkitMeasured,
    "linux",
  );
  assert(
    running.verdict.startsWith(
      "OBSERVED webkit on linux: the pure-Wasm guest kept running",
    ),
    running.verdict,
  );
  const stopping = await checkIsolatedTermination(
    "webkit",
    engineThat(() => 150),
    "linux",
  );
  assert(
    stopping.verdict.startsWith(
      "OBSERVED webkit on linux: the pure-Wasm guest stopped after every cancellation",
    ),
    stopping.verdict,
  );
});

Deno.test("WebKit on any host: a host-calling guest must stop within the bound", async () => {
  for (const os of ["darwin", "linux"]) {
    const message = await rejection(() =>
      checkIsolatedTermination("webkit", engineThat(() => null), os)
    );
    assert(message.includes("host-calling guest kept running"), message);
  }
});

Deno.test("Chromium and Firefox: every guest must stop within the bound", async () => {
  for (const engine of ["chromium", "firefox"] as const) {
    const result = await checkIsolatedTermination(
      engine,
      engineThat(() => 2_050),
      "linux",
    );
    assert(result.verdict.startsWith(`PASS ${engine}`), result.verdict);
    const message = await rejection(() =>
      checkIsolatedTermination(
        engine,
        engineThat((guest) => guest === "pure" ? null : 2_050),
        "linux",
      )
    );
    assert(message.includes("kept running past"), message);
  }
});
