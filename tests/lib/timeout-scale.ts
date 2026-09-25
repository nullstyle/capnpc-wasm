// One factor for the test timeouts that measure how fast the host is rather
// than what the code does (ledger row 143). CAPNP_TEST_TIMEOUT_SCALE (1 unless
// set; any positive number) multiplies run()'s default and build timeouts in
// process.ts and the browser and Studio drivers' Playwright timeouts, step
// deadlines, and engine deadline, so every bound keeps its order with the
// others. The nightly sets it on its slowest runners. Bounds that assert what
// the product does (a termination bound, a limit) and the calibrated SDK
// timeouts inside the browser pages, whose misses the stall rule budgets, do
// not scale. This module has no imports, so the browser drivers can use it.

/** The variable that sets the factor. */
export const timeoutScaleVariable = "CAPNP_TEST_TIMEOUT_SCALE";

/** The factor a value sets: 1 when unset or empty, else a positive number. */
export function parseTimeoutScale(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 1;
  const factor = Number(value);
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new TypeError(
      `${timeoutScaleVariable} must be a positive number, not ${
        JSON.stringify(value)
      }`,
    );
  }
  return factor;
}

/** A timeout in milliseconds multiplied by a factor, rounded up. */
export function scaleTimeout(ms: number, factor: number): number {
  return Math.ceil(ms * factor);
}

/**
 * The variable's value when this process may read it. A process without the
 * permission (the suites grant it through `[vars].suite_env` in mise.toml)
 * runs at scale 1 rather than failing or prompting.
 */
function readVariable(): string | undefined {
  const state = Deno.permissions.querySync({
    name: "env",
    variable: timeoutScaleVariable,
  }).state;
  return state === "granted" ? Deno.env.get(timeoutScaleVariable) : undefined;
}

/** This process's factor. */
export const timeoutScale: number = parseTimeoutScale(readVariable());

/** A timeout scaled by this process's factor. */
export function scaled(ms: number): number {
  return scaleTimeout(ms, timeoutScale);
}
