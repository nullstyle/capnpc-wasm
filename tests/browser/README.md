# Browser verification

Run from the repository root:

```sh
mise run browser:install
mise run test:browser
# Optionally select one engine (or any combination):
mise run browser:install firefox
mise run test:browser firefox webkit
```

The driver uses pinned Deno and `playwright@1.58.2`. By default, installation
and verification cover all three engines:

| Engine                  | Version      | Playwright revision |
| ----------------------- | ------------ | ------------------- |
| Chromium headless shell | 145.0.7632.6 | 1208                |
| Firefox                 | 146.0.1      | 1509                |
| WebKit                  | 26.0         | 2248                |

Browsers and the FFmpeg helper live under `.cache/playwright`; no Node
installation or system browser is used. On Linux, browsers still need the
platform libraries listed in
[Playwright's browser documentation](https://playwright.dev/docs/browsers#install-system-dependencies).

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
execution. Malformed and truncated Zig requests must exit unsuccessfully with
preserved diagnostics and no exposed output files. Worker abort and timeout must
terminate a job and allow reuse with identical output. Native output and
temporary browser profiles stay under `build/test/browser-*`; the output remains
available for inspection.

Published package installation and application-specific Content Security
Policies are outside this suite's current coverage. Browser versions follow the
pinned Playwright package rather than the user's installed browser versions.
