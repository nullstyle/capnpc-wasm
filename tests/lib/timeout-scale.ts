// One factor for the test timeouts that measure how fast the host is rather
// than what the code does (ledger row 143). CAPNP_TEST_TIMEOUT_SCALE (1 unless
// set; a plain decimal from 1 to 100) multiplies run()'s default and build
// timeouts in process.ts and the browser and Studio drivers' Playwright
// timeouts, step deadlines, close steps, and kill grace, so those bounds keep
// their order. The browser engine deadline stays 20 minutes: it still
// outlasts one failing step at the largest factor the nightly uses, and
// unscaled it bounds what one regression can cost a job. The nightly sets the
// factor on its slowest runners. Explicit timeouts, bounds that assert what
// the product does (a termination bound, a limit), and the other SDK bounds
// inside the browser pages (some budgeted by the stall rule) do not scale.
// This module has no imports, so the browser drivers can use it.

/** The variable that sets the factor. */
export const timeoutScaleVariable = "CAPNP_TEST_TIMEOUT_SCALE";

/** The largest factor: 100 keeps every scaled timer far below 2^31 ms. */
export const maxTimeoutScale = 100;

/**
 * The factor a value sets: 1 when unset or empty, else a plain decimal
 * (digits, optionally a point and more digits) from 1 to 100. Hexadecimal,
 * binary, exponents, and factors below 1, which would shrink the hang guards,
 * are refused.
 */
export function parseTimeoutScale(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 1;
  const text = value.trim();
  const factor = Number(text);
  if (
    !/^\d+(\.\d+)?$/.test(text) || factor < 1 || factor > maxTimeoutScale
  ) {
    throw new TypeError(
      `${timeoutScaleVariable} must be a positive number from 1 to ${maxTimeoutScale} in plain decimal, not ${
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
