// Labelled deadlines for the browser drivers (TST-07). Playwright's
// page.evaluate honours no timeout, so an engine that stalls would hold its
// driver until the CI job timeout; every step instead races a timer that fails
// with the step's own label. The clock also names the running step to a
// callback, which the driver keeps in a file for run.ts to report when it has
// to stop a driver from outside.

export class DeadlineError extends Error {
  override readonly name = "DeadlineError";
  constructor(readonly label: string, readonly ms: number) {
    super(`${label} did not finish within ${ms / 1000} seconds`);
  }
}

/** Race `pending` against a timer that rejects with a DeadlineError. */
export async function within<T>(
  pending: Promise<T>,
  label: string,
  ms: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DeadlineError(label, ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface StepClockOptions {
  /** The deadline of a step that names none. */
  defaultMs: number;
  /**
   * The stall drill: a step whose label contains this text never settles, so
   * the deadline itself can be demonstrated (CAPNP_BROWSER_STALL).
   */
  stall?: string;
  /** Called with each step's label as it starts. */
  onStep?: (label: string) => void;
}

export interface StepClock {
  /** Run one labelled step under its deadline. */
  step<T>(pending: Promise<T>, label: string, ms?: number): Promise<T>;
  /** The label of the step that started last. */
  readonly current: string;
}

export function stepClock(options: StepClockOptions): StepClock {
  let current = "start";
  return {
    get current() {
      return current;
    },
    step<T>(pending: Promise<T>, label: string, ms = options.defaultMs) {
      current = label;
      options.onStep?.(label);
      if (options.stall && label.includes(options.stall)) {
        // The real work keeps running unobserved; the step never settles.
        pending.catch(() => {});
        pending = new Promise<never>(() => {});
      }
      return within(pending, label, ms);
    },
  };
}

/** Read a positive number of milliseconds from the environment. */
export function envMilliseconds(name: string, fallback: number): number {
  const value = Deno.env.get(name);
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive number of milliseconds`);
  }
  return parsed;
}
