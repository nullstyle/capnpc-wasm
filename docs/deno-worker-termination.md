# Deno worker termination evidence

Observed on macOS arm64 on 2026-09-15 while validating the compiler-host
package. No SDK or browser behavior is inferred from a returned cancellation
promise.

The external package consumer compiled successfully and rejected timed-out and
aborted jobs, then Deno 2.9.6 failed to exit within a 60-second parent deadline.
Two terminated infinite guests continued consuming CPU. A minimal
plain-JavaScript worker reproduced the failure without SDK, WASI, compiler,
schema, or blob URL.

`tests/hosts/deno/worker-termination-probe.ts` starts a file worker that
increments a shared atomic counter continuously, calls `terminate()`, and
compares the counter three and four seconds later. Run it with read access to
its directory under an externally bounded process, for example an eight-second
subprocess timeout. The timeout must kill the child; affected Deno processes may
not exit. If the process that bounds it dies first, the probe exits within about
100 ms of being orphaned (its parent process ID changes), so an affected release
cannot keep spinning unattended.

| Deno  | Counter stable between 3s and 4s | Child exited before 8s |
| ----- | -------------------------------- | ---------------------- |
| 2.6.8 | Yes                              | Yes                    |
| 2.7.6 | No                               | Yes                    |
| 2.8.3 | No                               | No                     |
| 2.9.1 | No                               | No                     |
| 2.9.5 | No                               | No                     |
| 2.9.6 | No                               | No                     |

Earlier 100ms and one-second observations showed continued execution even on
2.6.8. Those short observations do not establish unbounded execution:
[Deno 2.6.8's worker implementation](https://raw.githubusercontent.com/denoland/deno/v2.6.8/runtime/web_worker.rs)
deliberately waits two seconds before requesting V8 isolate termination. The
three-to-four-second observation distinguishes that grace from later execution.
On 2.6.8 the counter grew from 11,746,464 immediately after termination to
443,199,715 at three seconds and remained exactly 443,199,715 at four seconds.
On 2.9.6 it grew from 686,010,554 at three seconds to 901,336,027 at four
seconds, then the outer eight-second timeout killed the process.

This evidence establishes the observed host/runtime behavior. It does not
identify a Deno source regression, establish termination bounds for untested
versions/platforms, or justify claiming that promise rejection immediately stops
guest CPU.

## Canary

A runtime that stops JavaScript but not Wasm, or a Deno release that restores
forced termination, would be invisible to a JavaScript-only probe (GAP2-08). The
probe therefore takes the guest as its argument: `js` (the default, the loop
above), `wasm` (a Wasm loop over a shared page), or `wasm-catch-all` (the same
loop inside `try_table (catch_all)` that retries, as C++ `catch (...)` would).
`tests/hosts/deno/worker-termination-canary.ts` runs every guest under each
runtime it is given, kills each run after eight seconds, and compares the result
with the table below: only `supportedDenoWorkerVersion` may stop the guest. (The
SDK no longer checks that deprecated constant; it stays exported for this
record.) `mise run test:termination-canary` runs it on the worker runtime, the
pinned Deno, and the newest release from dl.deno.land (`CAPNP_CANARY_LATEST=0`
skips that download); the nightly workflow runs the task without gating, and a
departure in either direction fails that job.

Observed on macOS arm64 on 2026-09-24 with the canary (the counter values are in
its receipt, `build/test/termination-canary.json`):

| Deno        | JS stopped | Wasm stopped | Wasm catch_all stopped | Child exited before 8 s |
| ----------- | ---------- | ------------ | ---------------------- | ----------------------- |
| 2.6.8       | Yes        | Yes          | Yes                    | Yes                     |
| 2.7.6       | No         | No           | No                     | Yes                     |
| 2.8.3       | No         | No           | No                     | No                      |
| 2.9.1       | No         | No           | No                     | No                      |
| 2.9.5       | No         | No           | No                     | No                      |
| 2.9.6 (pin) | No         | No           | No                     | No                      |

"Stopped" means the counter did not move between three and four seconds after
`terminate()`. On 2.6.8 every guest ran through the two-second grace and then
stopped (the Wasm counter reached 1,199,659,203 at three seconds and stayed
there). The catch_all handler never ran on any version: V8's termination is not
an exception Wasm can catch, so a C++ catch-all cannot keep a terminated guest
alive, and cannot help it stop either.

## The SDK no longer relies on terminate()

Every guest the TypeScript SDK runs is instrumented before it is compiled (see
[Interruption](../sdk/typescript/README.md#interruption)): the guest polls the
host every 65,536 ticks of its loop headers, function entries, import calls, and
bulk memory operations, every WASI import polls too, and a stop is a trap. A
timeout stops the guest at its own deadline in every engine. An abort or
`dispose()` reaches a running guest through a shared cell wherever a
`SharedArrayBuffer` can cross to the worker (always in Deno and Bun, in browsers
on cross-origin isolated pages). A timeout keeps the worker for the next job,
and so does an abort that reaches the guest through the cell; `dispose()`, and
an abort without shared memory, terminate it. `terminate()` is otherwise only a
fallback: when a cancelled job does not report within a second, for an abort
without shared memory, and for a failed or disposed worker. The evidence in this
document therefore records engine behavior, for the upstream report and the
canary; the SDK's bounds do not depend on it.

## Worker runtime policy

`createWorkerCompiler` is admitted in browsers, on every Deno release, and on
Bun (verified locally on Bun 1.3.14 in both modes; CI does not run Bun);
releases without standardized Wasm exception handling still fail the factories'
engine check. Node.js has no Web `Worker` and is rejected, as are unrecognized
hosts. `supportedDenoWorkerVersion` remains exported but deprecated: the SDK no
longer checks it, only this repository's termination canary reads it, and the
2.1-second restart grace is gone. The SDK worker tests run on the pinned Deno in
`mise run test`.

Measured on macOS arm64 on 2026-09-24 (Deno 2.9.6 and 2.6.8, Bun 1.3.14): a
guest that spins, sleeps in `poll_oneoff` for an hour, or tail-calls forever
without a loop rejects at its 200 ms deadline and stops 0.2 to 5 ms later in
direct execution; in a worker an abort rejects within 0.1 ms, and the next job
runs on the same worker 0.5 to 1 ms later, which it could not do while the
cancelled guest still occupied the worker's thread.

## Why terminate() stops nothing on Deno 2.7 and later

In Deno 2.6.8, `WebWorkerHandle::terminate` (runtime/web_worker.rs) signals the
worker's event loop and schedules `isolate_handle.terminate_execution()` two
seconds later. From 2.7.6 on (checked through 2.9.7) it only sets the
termination signal, disentangles the port, and wakes the event loop; the handle
still holds the isolate handle, but nothing calls `terminate_execution()`. A
worker that never returns to its event loop, such as a guest computing in Wasm,
is never stopped, and from 2.8 the process cannot exit while it runs. This has
not been reported upstream yet.

Deno 2.6.8 has a second, SDK-relevant quirk: when a message event and an expired
timer are due in the same turn, the message handler runs first, and the timer
still runs even if that handler cleared it (100 of 100 probes; Deno 2.9.6 runs
the timer first). The worker client therefore ignores every callback that
arrives after its exchange has ended.

## Browsers

The browser suite's
[termination acceptance](../tests/browser/README.md#termination-acceptance)
measures SDK cancellation with a shared counter after a timeout, an abort, and a
dispose. With in-guest interruption every guest stopped within the counter's 50
ms sampling, WebKit's pure-Wasm loop included, and the worker survived the
timeout and the abort: in Chromium 153 and WebKit 26.6 on macOS arm64 (measured
locally, 0 to 53 ms), in Chromium, Firefox 155, and WebKit on Linux (CI run
[36112686931](https://github.com/nullstyle/capnpc-wasm/actions/runs/36112686931),
0 to 50 ms), and on macOS in the nightly run
[36112692524](https://github.com/nullstyle/capnpc-wasm/actions/runs/36112692524)
(0 to 185 ms, the 185 ms being Firefox's abort). Without isolation the page
cannot see the guest; in all three engines on Linux the timeout rejected after
300 to 302 ms, and the next job ran on the same worker.

The engines' own `terminate()` differs, as measured before in-guest
interruption: on Linux CI (run 36103736516) Chromium stopped a terminated
worker's Wasm about 2.01 to 2.02 s after `terminate()`, Firefox at once in all
six cases, and WebKit stopped a guest when it next called into JavaScript but
never stopped a loop that stayed in Wasm (GAP2-V1). The SDK's bounds no longer
depend on those delays: without cross-origin isolation an abort terminates the
worker, and a guest that `terminate()` does not stop runs only until its own
`timeoutMs` and then traps.

## Alternatives considered

- A `node:vm` watchdog (`runInContext` with a timeout around `_start`) stops a
  Wasm loop on Deno and Node on the calling thread, but cannot deliver an abort,
  does not stop Wasm on Bun, and races the next script it kills if the guest
  finishes just as the watchdog fires (GAP2-06). It is not used.
- A subprocess host (`Deno.Command`, killed on cancellation) stops anything, but
  needs `--allow-run` for the Deno binary, which is effectively `-A` for the
  child, does not exist in browsers, and complicates packaging (GAP2-07). It is
  not used; it remains a possible opt-in for crash and memory containment.
