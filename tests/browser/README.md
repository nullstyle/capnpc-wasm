# Browser verification

Run from the repository root:

```sh
mise run browser:install
mise run test:browser
```

The driver uses pinned Deno and `playwright@1.58.2`. Its Chromium headless shell
(145.0.7632.6, Playwright revision 1208) and FFmpeg helper live under
`.cache/playwright`; no Node installation or system browser is used. On Linux,
Chromium still needs the platform libraries listed in
[Playwright's browser documentation](https://playwright.dev/docs/browsers#install-system-dependencies).

`install.ts` obtains the current platform's download plan from the pinned
Playwright package, downloads its official archives, and extracts them with the
mise-managed CMake. Playwright's own ZIP extractor stalls with the pinned Deno
release. Installation uses temporary directories beneath the project cache and
publishes each browser directory only after extraction succeeds. Complete
installations are reused; the installer needs network access only for missing
archives.

`test.ts` first compiles the fixture workspace with native upstream tools to
prepare its oracle. It reads the shipped modules and annotation schemas from
`dist/`, serves only the SDK bundles and four Wasm guests over a temporary
loopback server, then loads a direct compiler and a worker compiler in real
Chromium. The worker uses a preloaded Blob URL so cancellation and restart also
work offline.

Before compiling, the driver disables browser networking and revokes its own
Deno network and process-spawning permissions. The task uses `--no-prompt` to
prevent permissions from being requested again. Both browser paths must produce
byte-identical C++, Rust, and Go files for ordinary and Unicode schema paths,
preserve malformed-schema diagnostics, and make no new network requests. Worker
abort and timeout must terminate a job and allow reuse with identical output.
Native output and temporary browser profiles stay under `build/test/browser-*`;
the output remains available for inspection.

This suite establishes the Chromium baseline. Firefox, WebKit, published package
installation, and application-specific Content Security Policies are outside its
current coverage.
