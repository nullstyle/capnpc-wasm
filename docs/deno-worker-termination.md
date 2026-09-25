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
with the table below: only `supportedDenoWorkerVersion` may stop the guest.
`mise run test:termination-canary` runs it on the worker runtime, the pinned
Deno, and the newest release from dl.deno.land (`CAPNP_CANARY_LATEST=0` skips
that download); the nightly workflow runs the task without gating, and a
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

## Worker runtime policy

The SDK now admits Deno worker execution only on the verified 2.6.8 version, and
browsers; Bun, Node.js and unrecognized hosts are rejected before a worker is
created. Direct compilation remains available on other runtimes. It waits 2.1
seconds before restarting a terminated Deno worker, counting the wait toward the
next job's deadline, and it terminates a worker only for timeouts, aborts,
disposal, and worker failures, never for ordinary job errors. CI retains
supported-Deno worker tests and the real termination probe; the producer-pinned
Deno checks direct execution and early rejection of unsupported worker use. This
is a host compatibility policy, not a Deno engine fix.

## Browsers

Browser engines have their own termination behavior, which the browser suite's
[termination acceptance](../tests/browser/README.md#termination-acceptance)
measures with a shared counter after a timeout, an abort, and a dispose.
Chromium stops a running guest about 2.05 s after `terminate()`. WebKit stops a
guest when it next calls into JavaScript (a WASI import), but never stops a loop
that stays in Wasm; that case is an expected failure until T08's in-guest
interruption (decision D1 = A) lands. Firefox runs in the hosted Linux job; it
cannot launch on the development host where the table was measured.
