# Browser verification

Run from the repository root:

```sh
mise run browser:install
mise run test:browser
# Optionally select one engine (or any combination):
mise run browser:install firefox
mise run test:browser firefox webkit
```

The driver uses pinned Deno and `playwright@1.63.0`. By default, installation
and verification cover all three engines:

| Engine                  | Version       | Playwright revision |
| ----------------------- | ------------- | ------------------- |
| Chromium headless shell | 153.0.8010.12 | 1243                |
| Firefox                 | 155.0         | 1543                |
| WebKit                  | 26.6          | 2359                |

Browsers and the FFmpeg helper live under `.cache/playwright`; no Node
installation or system browser is used. On Linux, browsers still need the
platform libraries listed in
[Playwright's browser documentation](https://playwright.dev/docs/browsers#install-system-dependencies).

Install those libraries using the same pinned package (the CLI invokes the
system package manager and may request sudo):

```sh
mise exec -- deno run --config tests/browser/deno.json --frozen --allow-read --allow-env --allow-sys --allow-run --allow-net tests/browser/playwright.ts install-deps chromium firefox webkit
```

The small `playwright.ts` bootstrap also runs the pinned upstream CLI. During
package import only, it treats a denied optional WSL detection probe at
`/proc/sys/fs/binfmt_misc/WSLInterop` as unavailable. Deno continues to deny
access to that privileged path. The original `fs.existsSync` function is
restored in `finally`, and other paths and errors retain their behavior. The
bootstrap test verifies both restoration and the retained Linux permission
denial. No additional permissions are granted.

`install.ts` obtains the current platform's download plan from the pinned
Playwright package, downloads its official archives, checks each one's sha256
against the digest recorded in `install.ts` before extracting it (an archive
without a recorded digest, or with another one, is never extracted), and
extracts it with the mise-managed CMake. Playwright's own ZIP extractor stalls
with the pinned Deno release. Installation uses temporary directories beneath
the project cache and publishes each browser directory only after extraction
succeeds. Complete installations are reused; the installer needs network access
only for missing archives. After a Playwright bump,
`mise run browser:install -- --print-digests` prints the digests to record.

`run.ts` runs each selected engine in a separate Deno process, allowing each
driver to independently revoke permissions, and starts the drivers together;
their output is prefixed with the engine, and a summary per engine closes the
run. `test.ts` first compiles the fixture workspace with native upstream tools
to prepare its oracle. It reads the shipped modules and annotation schemas from
`dist/`, serves only the SDK bundles, the Wasm modules, the Studio adapter, and
the standard schemas over a temporary loopback server, then loads a direct
compiler and a worker compiler in real browser engines. The worker uses a
preloaded Blob URL so cancellation and restart also work offline. The driver
imports the SDK's request, result, module, option, and error types from
`sdk/typescript/types.ts`; `sdk.ts` states the worker client's interface, which
`sdk/typescript/conformance_test.ts` checks against the SDK's own at type level.

Every browser step (launch, page load, each `page.evaluate`, close) runs under a
labelled deadline, 60 seconds by default, and a stalled engine fails with the
step's label:
`chromium worker abort recovery cycle 3 did not finish within 60
seconds`. The
driver records the running step next to its receipt. `run.ts` gives each driver
an overall deadline, 20 minutes by default; past it, the driver receives
SIGTERM, names the step it was on, and closes its browser, and it is killed 30
seconds later if it has not exited. Environment variables adjust this:

| Variable                          | Effect                                                           |
| --------------------------------- | ---------------------------------------------------------------- |
| `CAPNP_BROWSER_DEADLINE_MS`       | Each step's deadline (default 60000)                             |
| `CAPNP_BROWSER_ENGINE_TIMEOUT_MS` | Each driver's overall deadline (default 1200000)                 |
| `CAPNP_BROWSER_JOBS`              | Drivers that run at once (default 3; 1 runs the engines in turn) |
| `CAPNP_BROWSER_STALL`             | Hangs the first step whose label contains the text, as a drill   |

For example,
`CAPNP_BROWSER_STALL="abort recovery cycle 3" CAPNP_BROWSER_DEADLINE_MS=5000 mise run test:browser chromium`
fails on that step five seconds after it starts. `deadline_test.ts`, part of
`test:browser-bootstrap`, checks the deadline without a browser.

Before compiling, the driver blocks network requests and WebSocket connections,
closes its asset server, and revokes its own Deno network and process-spawning
permissions. Chromium and Firefox also enable browser offline emulation.
Playwright's WebKit offline emulation blocks even local Blob worker reloads;
that engine uses request interception instead, allowing only preloaded Blob
URLs. The task uses `--no-prompt` to prevent permissions from being requested
again. Both browser paths must produce byte-identical C++, Rust, Go, and Zig
files for ordinary and Unicode schema paths, preserve malformed-schema
diagnostics, and make no new network requests. The shared feature corpus also
covers binary/text embeds, generic brands, AnyPointer defaults, groups, integer
limits, and parent-directory imports. Saved native requests generate identical
source through the standalone `generate` API in both direct and worker
execution. The Zig RPC scenarios also cover generic interfaces, imported and
inherited bindings, method generics, and streaming methods with the shipped
`capnp/stream.capnp` include. Both direct and worker compilation and
saved-request generation compare every generated Zig file byte with fresh native
output.

The driver saves every compiler request before exiting. Its parent then runs the
native `normalize-request` oracle over those saved bytes and compares the entire
canonical binary request against the native compiler, sorting only the `nodes`
and `sourceInfo` maps. The browser driver keeps its process and network
permissions revoked throughout execution; canonicalization happens afterward in
the parent. Missing direct/worker receipts, malformed requests, and byte
differences fail the engine's result. Raw and canonical requests remain beside
the generated fixtures for inspection.

Malformed and truncated Zig requests must exit unsuccessfully with preserved
diagnostics and no exposed output files. Twenty alternating worker abort and
timeout operations must reject their jobs and let the same client then compile
identical output. Each cancels a compile for a zig generator that spins forever
(`spin-yield.wat`), so the job can never finish first; each recovery compiles
the workspace with the real compiler and the C++, Rust, and Go generators, whose
files are checked against the native oracle. On this page, which is not
cross-origin isolated, each abort replaces the worker and each timeout keeps it.
The step deadlines detect a stalled browser without changing the SDK's
cancellation or its normal 30-second recovery budget. Native output and
temporary browser profiles stay under `build/test/browser-*`; the output remains
available for inspection.

Direct and worker clients also reject aggregate workspace and output overages
without returning partial output, then successfully execute another permitted
job. A small Wasm command attempts two memory grows from one page; its observed
memory size must remain at the configured two-page ceiling in every engine. A
second command writes seven single-byte chunks under a six-byte stdout limit,
catching quota bypasses when the shim grows a resizable ArrayBuffer in place.

The hostile guests under `guests/` run in both modes as well. Each one-page
command asks the host for more than the guest owns (oversized read iovec arrays,
a 2 GiB random fill, a descriptor flood, writes at pointers outside memory),
mutates the read-only compiler workspace, or publishes output names such as
`__proto__` and `a\b`. Every call must finish in under a second with the
expected errno bytes, a plain-object result, or a `CompileError`, without a host
allocation proportional to the request. The driver assembles every
`guests/*.wat` with the pinned `wasm-tools` (`parse`, then `strip --all`) and
refuses to run if the bytes differ from the copies embedded in
`sdk/typescript/testdata/hostile_guests.ts`, which the permission-restricted SDK
tests use.

## Termination acceptance

The recovery cycles show that a client keeps producing correct output after
cancellations; they do not show that a cancelled guest stopped running.
`termination.ts` does. Two more pages audit every Worker the SDK creates and
terminates. On a cross-origin-isolated page (COOP and COEP), a probe worker
wraps the SDK's `worker.js` and counts the guest's progress in shared memory.
Before each cancellation the counter must move within one 50 ms sample, so a
stop can be observed. After each of a timeout, an abort, and a dispose, the page
watches the counter for up to 3 seconds, until it has not moved for one second,
and its last movement must come within 2 seconds of the rejection, forty times
the 50 ms interval at which the page samples it. The worker must survive the
timeout and the abort: once the page has waited out the client's one-second
grace, in which a cancelled guest must report, no `terminate()` call and no
second worker may have occurred, and a follow-up job on the same client must
time out in its turn. Two guests run through the whole SDK path as the job's
compiler:

- `spin-counter.wat`, a loop that never calls an import, like a compiler stuck
  computing; the probe counts its polls of the `capnp_wasm.interrupt` import the
  SDK injects.
- `spin-yield.wat`, which calls WASI `sched_yield` on every iteration; the probe
  counts the calls.

A plain page repeats the timeout without isolation. There the guest cannot be
observed, but the timeout must reject within its deadline, and the page then
waits out the client's grace before the follow-up job: a guest that had not
reported by then would have made the client terminate its worker, so no
`terminate()` call and no second worker show that it stopped. The checks run
after everything else.

| Engine                         | Pure-Wasm guest stops after    | Host-calling guest stops after |
| ------------------------------ | ------------------------------ | ------------------------------ |
| Chromium 153.0.8010.12 (macOS) | 0-53 ms                        | 0 ms                           |
| WebKit 26.6 (macOS)            | 0-51 ms                        | 0 ms                           |
| Firefox 155.0 (Linux CI)       | asserted; first CI run pending | asserted; first CI run pending |

The macOS figures were measured on arm64 on 2026-09-24, over a timeout, an
abort, and a dispose each; the 50 ms sampling quantizes them. Before the SDK
interrupted guests itself, WebKit kept the pure-Wasm guest running after every
cancellation (GAP2-V1) and Chromium stopped a guest only about 2 s after
`terminate()`; the
[termination evidence](../../docs/deno-worker-termination.md#browsers) keeps
those engine measurements. Each run prints
`OBSERVED <engine> termination on <os>: ...` with every sample's stop time, so
CI keeps the numbers. `termination_test.ts`, part of `test:browser-bootstrap`,
checks these verdicts without a browser.

## Conformance corpus

The driver also runs the
[failure and limit conformance corpus](../fixtures/conformance/README.md) on
three surfaces in each engine: `createCompiler`, `createWorkerCompiler`, and the
Schema Studio adapter (`examples/browser/compiler.js`, bundled for the page with
the pinned Deno, which is primed with every module while the asset server is
up). The page runs each case through `tests/conformance/page-runner.js`, the
runner the Deno surfaces use, and the driver checks the classified outcome
against the surface's column of `expected.json`, including `<surface>@<engine>`
departures. On macOS the rows measured a small worker stack in WebKit: about 34
const references and 90 nested imports, against 275 and 744 in a Chromium
worker, which matches macOS's 512 KiB default for secondary threads; near that
limit the outcome varies between runs. Linux threads default to 8 MiB, and on
Linux CI (run 36099823012) WebKit and Firefox workers compiled the 100-deep
chains. The WebKit worker depth rows therefore accept both outcomes, each with
its full checks, and every row that accepts more than one outcome prints the
whole observation (`OBSERVED ...`: outcome, stage, outputs, diagnostics), which
the run summary repeats.

## Hosted CI

Hosted CI runs this complete three-engine suite and the Schema Studio suite in a
separate Linux job after installing the browser system libraries with the pinned
Playwright CLI; the clean-checkout job on Linux and macOS runs `mise run check`,
`mise run test:package`, the Deno 2.6.8 worker lane, and the Go race tests. The
lanes are listed in
[CONTRIBUTING.md](../../CONTRIBUTING.md#reproducing-the-ci-lanes). Build trees
are not restored from caches, and failed test fixtures plus the exact tested
Wasm modules and SDK bundles are retained as workflow artifacts.

Published package installation is outside this suite's current coverage. The
Schema Studio driver runs under Studio's own Content-Security-Policy (see the
Studio guide) and fails on any axe-core violation; the SDK driver applies no
policy of its own. Browser versions follow the pinned Playwright package rather
than the user's installed browser versions.

## Engine regression evidence

The first hosted Linux run trapped in WebKit after a worker timeout. That exact
null-reference trap did not reproduce locally, and the subsequent hosted
`92d55f3` browser matrix passed. A separate repeated-cancellation probe did
reproduce a stall in the older engine. The following control used unchanged SDK
and Wasm bytes in a Linux x86_64 container, with the original person workspace
and all four generators:

| Playwright / WebKit revision | Active cancellation followed by recovery   |
| ---------------------------- | ------------------------------------------ |
| 1.58.2 / 2248                | Stalled at cycle 9 without instrumentation |
| 1.61.1 / 2311                | Stalled at cycle 17                        |
| 1.63.0 / 2359                | Passed 100 consecutive cycles              |

Replacing the whole SDK client and retaining the full Wasm instance did not
remove the old-engine stall. Twenty replacements of idle workers passed. The
full browser regression with revision 2248 stopped during its twelfth recovery.
The current twenty-cycle test, whose ten aborts each replace the worker, keeps
exercising that pattern in each engine: every recovery runs the real compiler,
and its C++, Rust, and Go files are checked against the native oracle, while the
suite's parity rows check the compiler requests. The A/B evidence motivates the
browser upgrade without claiming it proves the cause of the earlier hosted trap.

After the upgrade, the complete macOS three-engine matrix passed all sixty
cancellation/recovery cycles. The Linux container also passed the complete
WebKit suite and its subsequent canonical request audit. The bootstrap
permission regression passes on both hosts.

To repeat the control, retain the built `dist/` assets in a disposable checkout,
change only the Playwright pin and frozen lock, install that engine, and invoke
the driver directly to avoid rebuilding the SDK:

```sh
mise run browser:install webkit
mise exec -- deno run --config tests/browser/deno.json --frozen --no-prompt --allow-read --allow-write=build --allow-run --allow-env --allow-sys --allow-net=127.0.0.1 tests/browser/run.ts webkit
```

## Schema Studio

`mise run test:studio` exercises the actual browser workbench in all three
engines. Its separate driver, `studio.ts`, keeps the SDK driver's offline and
permission-revocation guarantees unchanged. It uses the same static handler as
the example server and compares downloaded generated files with fresh native
C++/Rust/Go/Zig output. It also covers workspace editing, error recovery,
cancellation, binary imports/exports, file management, and responsive layouts.
Evidence lives under `build/test/studio-*/`; browser CI retains failing fixtures
and the complete Studio bundle. See the
[Studio guide](../../examples/browser/README.md).
