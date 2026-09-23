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
not exit.

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
guest CPU. Browser-worker cancellation has independent browser acceptance tests.

The SDK now admits Deno worker execution only on the verified 2.6.8 version, and
browsers; Bun, Node.js and unrecognized hosts are rejected before a worker is
created. Direct compilation remains available on other runtimes. It waits 2.1
seconds before restarting a terminated Deno worker, counting the wait toward the
next job's deadline, and it terminates a worker only for timeouts, aborts,
disposal, and worker failures, never for ordinary job errors. CI retains
supported-Deno worker tests and the real termination probe; the producer-pinned
Deno checks direct execution and early rejection of unsupported worker use. This
is a host compatibility policy, not a Deno engine fix.

Browser engines have their own termination behavior, which the SDK does not yet
compensate for: WebKit never stops a running Wasm guest on `terminate()`.
Chromium stops it after about 2 s. Firefox is untested.
