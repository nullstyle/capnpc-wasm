/**
 * In-guest interruption, shared by the rewriter (wasm.ts) and the runtime.
 *
 * compileBounded instruments every guest module: a countdown global ticks at
 * each loop header, at the entry of each function that can call guest code,
 * and after each direct call to an import. Every `pollInterval` ticks the
 * guest calls the one added import, `capnp_wasm.interrupt`. A nonzero answer
 * executes `unreachable`. That is a trap, which no `try_table`/`catch_all` in
 * the guest can intercept, so guest cleanup and `catch (...)` handlers never
 * run after a stop. `proc_exit` is followed by an injected `unreachable`, and
 * the exported countdown lets the host force the next check to poll.
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
