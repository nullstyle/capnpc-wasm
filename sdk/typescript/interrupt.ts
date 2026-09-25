/**
 * In-guest interruption, shared by the rewriter (wasm.ts), the runtime and
 * both execution modes.
 *
 * compileBounded instruments every guest module: a countdown global ticks at
 * each loop header, at the entry of each function that can call guest code,
 * and after each direct call to an import. Every `pollInterval` ticks the
 * guest calls the one added import, `capnp_wasm.interrupt`, which answers from
 * the job's JobControl. A nonzero answer executes `unreachable`. That is a
 * trap, which no `try_table`/`catch_all` in the guest can intercept, so guest
 * cleanup and `catch (...)` handlers never run after a stop.
 *
 * The host stops a guest from inside an import the same way, never by
 * throwing into it: the runtime records why, zeroes the exported countdown,
 * and the check right after the import call polls and traps. `proc_exit`
 * is followed by an injected `unreachable` as well.
 */

/** Module and field of the import instrumentation adds: `() -> i32`. */
export const interruptModule = "capnp_wasm";
export const interruptName = "interrupt";
/**
 * The countdown global instrumentation adds and exports. Zeroing it makes the
 * guest's next check poll the interrupt import.
 */
export const countdownExport = "capnp_wasm.countdown";
/** Guest checks between two host polls. */
export const pollInterval = 65536;

/** Job deadline used when a caller passes no `timeoutMs`. */
export const defaultTimeoutMs = 30_000;

export function timeoutError(): DOMException {
  return new DOMException("compilation timed out", "TimeoutError");
}

/** The same bound setTimeout accepts, so both execution modes agree. */
export function checkTimeout(timeoutMs: unknown, name: string): number {
  if (
    typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 || timeoutMs > 2_147_483_647
  ) {
    throw new TypeError(`${name} must be positive and at most 2147483647`);
  }
  return timeoutMs;
}

/**
 * Check a job's options the same way in both execution modes, before the
 * request itself: an object (or nothing), a timeout checkTimeout accepts, and
 * an AbortSignal. An already aborted signal rejects with its reason.
 */
export function jobOptions(
  options: unknown,
): { signal?: AbortSignal; timeoutMs: number } {
  if (options === undefined) return { timeoutMs: defaultTimeoutMs };
  if (typeof options !== "object" || options === null) {
    throw new TypeError("job options must be an object");
  }
  const { signal, timeoutMs = defaultTimeoutMs } = options as {
    signal?: unknown;
    timeoutMs?: unknown;
  };
  checkTimeout(timeoutMs, "timeoutMs");
  if (
    signal !== undefined &&
    (typeof signal !== "object" || signal === null ||
      typeof (signal as AbortSignal).aborted !== "boolean" ||
      typeof (signal as AbortSignal).addEventListener !== "function")
  ) throw new TypeError("signal must be an AbortSignal");
  if ((signal as AbortSignal | undefined)?.aborted) {
    throw (signal as AbortSignal).reason;
  }
  return {
    signal: signal as AbortSignal | undefined,
    timeoutMs: timeoutMs as number,
  };
}

// A private cell for CPU-free sleeps where nothing else can wake the thread.
let sleepCell: Int32Array | undefined;
// Atomics.wait throws on threads that must not block (browser main threads).
let blockingAllowed = typeof SharedArrayBuffer === "function";

/**
 * Block the calling thread for up to `milliseconds` on `cell` while it holds
 * `value`. Returns false where blocking is unavailable.
 */
function block(
  cell: Int32Array | undefined,
  value: number,
  milliseconds: number,
): boolean {
  if (!blockingAllowed) return false;
  try {
    cell ??= sleepCell ??= new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(cell, 0, value, milliseconds);
    return true;
  } catch {
    blockingAllowed = false;
    return false;
  }
}

export interface JobControlOptions {
  /** performance.now() time after which the job times out. */
  deadline?: number;
  /** Caller cancellation; seen whenever the job polls. */
  signal?: AbortSignal;
  /**
   * A cell shared with the thread that owns the job: storing `token` in
   * element 0 (then Atomics.notify) cancels it from outside this thread.
   */
  cell?: Int32Array;
  /** This job's nonzero token in `cell`. */
  token?: number;
}

/**
 * One job's deadline and cancellation state. The injected guest checks poll
 * `cancelled()`; the first reason observed sticks, so later polls and the
 * caller agree on why the job stopped.
 */
export class JobControl {
  readonly deadline: number;
  readonly #signal?: AbortSignal;
  readonly #cell?: Int32Array;
  readonly #token: number;
  #stopped = false;
  #reason: unknown;

  constructor(
    { deadline = Infinity, signal, cell, token = 0 }: JobControlOptions = {},
  ) {
    if (cell && token === 0) {
      throw new RangeError("a shared cancellation cell needs a nonzero token");
    }
    this.deadline = deadline;
    this.#signal = signal;
    this.#cell = cell;
    this.#token = token;
  }

  /** Whether the job must stop; records the reason the first time. */
  cancelled(): boolean {
    if (this.#stopped) return true;
    let reason: unknown;
    if (this.#cell && Atomics.load(this.#cell, 0) === this.#token) {
      reason = new DOMException("compilation cancelled", "AbortError");
    } else if (this.#signal?.aborted) reason = this.#signal.reason;
    else if (performance.now() >= this.deadline) reason = timeoutError();
    else return false;
    this.#stopped = true;
    this.#reason = reason;
    return true;
  }

  /** Why the job stopped: `TimeoutError`, `signal.reason`, or an `AbortError`. */
  get reason(): unknown {
    return this.#reason;
  }

  throwIfCancelled(): void {
    if (this.cancelled()) throw this.#reason;
  }

  /**
   * Sleep for up to `milliseconds` on behalf of the guest, never past the
   * deadline and waking early when the shared cell cancels the job. Blocks
   * without CPU where Atomics.wait is allowed (Deno, workers); elsewhere it
   * spins, as the pinned shim does.
   */
  sleep(milliseconds: number): void {
    const until = Math.min(
      performance.now() + Math.max(0, milliseconds),
      this.deadline,
    );
    while (!this.cancelled()) {
      const remaining = until - performance.now();
      if (remaining <= 0) return;
      const value = this.#cell ? Atomics.load(this.#cell, 0) : 0;
      if (value === this.#token && this.#cell) continue;
      block(this.#cell, value, remaining);
    }
  }
}

/**
 * Thrown by runCommand when the job's control stopped the guest. The engine
 * rethrows `reason`; `stderr` is what the guest wrote before it stopped.
 */
export class Cancelled extends Error {
  override readonly name = "Cancelled";
  constructor(readonly reason: unknown, readonly stderr: string) {
    super("the job was cancelled", { cause: reason });
  }
}
