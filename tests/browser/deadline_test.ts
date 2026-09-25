// The browser drivers' step deadlines (TST-07), without launching a browser:
// a step that stalls must fail with its own label within its deadline.
import { DeadlineError, stepClock, within } from "./deadline.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("a step that settles in time returns its value", async () => {
  assert(await within(Promise.resolve(7), "quick step", 1_000) === 7, "value");
});

Deno.test("a stalled step fails with its label within the deadline", async () => {
  const started = performance.now();
  try {
    await within(new Promise(() => {}), "chromium worker abort cycle 3", 100);
    throw new Error("the stalled step settled");
  } catch (error) {
    assert(
      error instanceof DeadlineError &&
        error.message ===
          "chromium worker abort cycle 3 did not finish within 0.1 seconds",
      `unexpected rejection: ${error}`,
    );
  }
  const elapsed = performance.now() - started;
  assert(elapsed < 1_000, `the deadline fired after ${elapsed} ms`);
});

Deno.test("the stall drill hangs only the matching step and names it", async () => {
  const started: string[] = [];
  const clock = stepClock({
    defaultMs: 100,
    stall: "replay",
    onStep: (label) => started.push(label),
  });
  assert(
    await clock.step(Promise.resolve("ok"), "compile person") === "ok",
    "",
  );
  let failure: unknown;
  try {
    await clock.step(Promise.resolve("ok"), "replay person");
  } catch (error) {
    failure = error;
  }
  assert(
    failure instanceof DeadlineError && failure.label === "replay person",
    `the drill did not stall the replay step: ${failure}`,
  );
  assert(clock.current === "replay person", `current is ${clock.current}`);
  assert(
    JSON.stringify(started) === '["compile person","replay person"]',
    JSON.stringify(started),
  );
});
