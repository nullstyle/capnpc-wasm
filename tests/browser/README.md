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
Playwright package, downloads its official archives, and extracts them with the
mise-managed CMake. Playwright's own ZIP extractor stalls with the pinned Deno
release. Installation uses temporary directories beneath the project cache and
publishes each browser directory only after extraction succeeds. Complete
installations are reused; the installer needs network access only for missing
archives.

`run.ts` runs each selected engine in a separate Deno process, allowing each
driver to independently revoke permissions. `test.ts` first compiles the fixture
workspace with native upstream tools to prepare its oracle. It reads the shipped
modules and annotation schemas from `dist/`, serves only the SDK bundles and
five Wasm guests over a temporary loopback server, then loads a direct compiler
and a worker compiler in real browser engines. The worker uses a preloaded Blob
URL so cancellation and restart also work offline.

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
timeout operations must terminate their jobs and allow reuse with identical
output after every replacement. A separate 60-second host deadline detects a
stalled browser without changing the SDK's one-millisecond cancellation budget
or its normal 30-second recovery budget. Native output and temporary browser
profiles stay under `build/test/browser-*`; the output remains available for
inspection.

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

Cancellation evidence is about the SDK client, not the engine: WebKit never
stops a running Wasm guest on `terminate()`. Chromium stops it after about 2 s.
Firefox is untested. The recovery cycles below show that replacement workers
keep producing correct output; they do not show that the terminated guest
stopped consuming CPU.

Hosted CI runs `mise run check` from clean Linux and macOS checkouts. A separate
Linux job installs the browser system libraries with the pinned Playwright CLI
and executes this complete three-engine suite. Build trees are not restored from
caches, and failed test fixtures plus the exact tested Wasm modules and SDK
bundles are retained as workflow artifacts.

Published package installation and application-specific Content Security
Policies are outside this suite's current coverage. Browser versions follow the
pinned Playwright package rather than the user's installed browser versions.

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
The current twenty-replacement test preserves that failure pattern in each
engine; compiler requests and every generated file remain checked against the
native oracle. The A/B evidence motivates the browser upgrade without claiming
it proves the cause of the earlier hosted trap.

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
