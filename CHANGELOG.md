# Changelog

One section per artifact flavor. Dates are the GitHub publication dates (UTC)
for published assets. Archive and manifest digests and producer commits live in
[published releases](docs/releases.md#published-releases). Later work appends
one-line bullets under "Unreleased"; a release moves them under the artifact and
version that ships them.

## Unreleased

- Documentation: consumer quick start, support matrix, generated-code runtime
  requirements, published-release digests, security policy, threat model,
  contributor guide, architecture overview, and a dated release-readiness gate
  table; historical sprint and audit records moved to `docs/history/`.
- Launcher: executable with `bin` entry, symlink/CDPATH-safe self-location, 256
  MiB/8 MiB/300 s guest bounds with env overrides, Wasmtime patch-release
  acceptance, `--help`/`--version`, exit-code contract, `argv[0]` `capnp`,
  read-only workspace copy, staged generator output.
- Tests: `test:cli-parity` runs upstream `capnp-test.sh` and conversion/eval
  matrices on native, the launcher, Wasmtime, wazero, and the Deno host,
  byte-compared with native.
- Go SDK, breaking before the first tag: `Language` and `Stage` are named types
  (`Modules.Generators`, `Generators`, and `Outputs` are keyed by `Language`),
  stages `compile` and `generate` are now `compiler` and the generator's
  language, and `Diagnostic.Message` is `Diagnostic.Stderr`.
- Go SDK: `Request.ImportPaths` and `Request.SourcePrefix` with the TypeScript
  validation and argument order; `WithLimits`/`DefaultLimits` with the
  TypeScript names and defaults; `WithMaxConcurrentJobs`; `Error` gains
  `ExitCode`, `Limit`, and `Diagnostics` (every stage so far); sentinels
  `ErrInvalidRequest` and `ErrLimitExceeded`; the C++ generator runs as
  `capnpc-c++`; paths of 4,092 to 4,096 bytes compile; generators may create
  4,096 entries (was 4,095); output-budget breaches name the budget instead of
  surfacing as opaque exit codes; SDK tests skip outside the checkout.
- Documentation: `docs/sdk-contract.md` defines the shared SDK contract, with
  the limit defaults pinned in `tests/fixtures/contract/limits.json`; the Go
  package consumer compares complete digest maps and the compiler-path fixture.
- Schema Studio: new files carry the Go and C++ annotations, saved workspace
  ZIPs import again (declared sizes checked before inflating), hidden entries
  such as `.git/` are skipped and counted, Studio's limits match the SDK budget
  including the bundled includes, failures show the SDK message above the raw
  diagnostics, edits during a run offer a restart, unsupported engines get a
  clear message, one worker grows with the languages used instead of being
  rebuilt, the build stages and versions every asset and ships only the used
  modules with a Licenses page, `index.html` carries a Content-Security-Policy
  and `serve-example.ts` adds the header-only policies and a loopback Host
  allow-list, controls stay focusable while a job runs with manual tab
  activation, live regions announce transitions only with persistent errors,
  colours are tokens meeting 4.5:1, the resize handle keeps the responsive
  sidebar, and the page has an `h1`; the pure `state.js` module has Deno unit
  tests (`test:studio-unit`), and the browser driver adds keyboard, axe-core
  (4.13.0), cancellation, and asset-failure coverage.
- Toolchain: `mise.lock` records the sha256 and minisign provenance of the
  pinned Zig development build for all four platforms (ziglang.org no longer
  serves it; mise verifies the community-mirror download against them), and
  `mise run mirror:zig` stages, verifies, and records checksums for a
  project-owned mirror of the tarballs.
- Browsers: `mise run browser:install` verifies every Playwright archive against
  a recorded sha256 before extracting it (Linux and macOS, x64 and arm64);
  `--print-digests` prints the entries to record after a Playwright bump.
- Toolchain: the Deno worker runtime is the locked tool `deno-worker` (GitHub
  release asset, sha256 and attestation in `mise.lock`; `deno-worker` on PATH
  beside the pinned `deno`), and `test:deno-worker` reads the required version
  from `sdk/typescript/environment.ts`, where wave 1 moved it.
- Verification tasks for the scheduled workflows: `check:lock-urls`
  (reachability of every locked download, with the Zig community mirrors as the
  fallback), `test:browser-soak` and `test:deno-worker-soak` (repeated
  cancellation and recovery), `test:sdk-go-floor` (the go.mod floor toolchain),
  `test:sdk-go-wazero-latest` (drift against newer wazero), `audit:osv`,
  `audit:govulncheck`, and `audit:advisories` (OSV.dev for the runtime pins and
  the Deno lockfiles).
- Wasm modules: byte-identical from any checkout path for a given WASI SDK
  platform tarball (C++ `-ffile-prefix-map`, Rust `--remap-path-prefix` and a
  staged workspace; the sysroot bakes its own build root into two libc++abi
  strings, so the macOS and Linux tarballs differ); the C++ modules ship without
  the sysroot's DWARF (`capnp.wasm` 3,004,843 to 1,986,544 bytes) and keep their
  name section; `scripts/check-wasm-artifacts.ts` and `check:wasm-artifacts`
  (part of `test`) enforce one feature allow-list per module class, the declared
  target features, no DWARF or build-host paths, and size budgets.
- Compiler port: under WASI `main()` always returns its status (no WASI call
  after `proc_exit` on JavaScript hosts), a missing `/` preopen is reported as
  `*** Uncaught exception ***` naming the preopen with exit 1 instead of an
  opaque trap; the build compiles as gnu++23 with upstream's warnings, `-Werror`
  for patched units, and a configure-time check of the source lists; the port
  README documents the runtime profile and minimum engines.
- Notices: `licenses/` is generated per artifact from the build graph (Go
  modules, Rust crates, the WASI SDK 34 wasi-libc and LLVM runtime texts
  vendored under `third_party/`, musl's COPYRIGHT included) with a
  `THIRD_PARTY_NOTICES-<flavor>.md` per archive flavor and `components.json`;
  the misattributed Zig libc/libc++ texts are gone.
- Release pipeline: `.github/workflows/release.yml` builds each flavor from its
  tag (`capnp-wasm-tools-v*`, `capnp-wasm-compiler-host-v*`, `capnpc-wasm-v*`)
  on a clean checkout with a green CI run (or the full check), runs the package
  gates, attaches build-provenance and SBOM attestations, and drafts the
  prerelease; a `workflow_dispatch` run is a dry run. `scripts/release.ts` gains
  `--publish` (requires the tag at `HEAD`, a clean tree, and a CHANGELOG entry),
  refuses dirty trees and versions whose tag exists at another commit in
  candidate mode (`--allow-dirty`, `--allow-existing-tag`), and takes
  `--out <dir>`; the package tests prepare under `build/test/` and never touch
  `dist/releases/`.
- Release assets: `SHA256SUMS` lists the archive, `<stem>.manifest.json` (the
  manifest as its own asset, so `sha256sum -c` passes before extraction), and
  `<stem>.spdx.json`, an SPDX 2.3 SBOM built from the manifest,
  `components.json`, and the tool pins; `<stem>.notes.md` carries the release
  notes. `scripts/verify-release.ts` takes `--sums`, `--expect-manifest-sha256`,
  `--expect-commit`, and `--require-clean`.
- Packaged documents: each archive's `README.md` is generated per flavor from
  `scripts/templates/` (verification, package-relative usage, links to the
  repository at the producer commit; no status claims) and its examples run in
  `test:package` and `test:compiler-host-package`; `docs/typescript.md` and the
  packaged `sdk/go/README.md` have their relative links rewritten to the
  repository at that commit; `docs/releases.md` is no longer copied into
  archives. `THIRD_PARTY_NOTICES.md` ships at the package root and `licenses/`
  holds only the flavor's texts. The full SDK archive packages every non-test
  `.go` file of the Go SDK.
- Zig generator: `ref/capnp-zig` advances from `0fb8df4` to `295ff5e`, the
  revision the scheduled nightly measures (Zig pin unchanged,
  `0.17.0-dev.1683+5ceec001b`); generated Zig output needs the runtime at
  `295ff5e`, and on an interface with streaming methods an error from an
  ordinary method now returns an exception for that call only instead of
  rejecting the calls after it.
- Tests: a failure and limit conformance corpus (`tests/fixtures/conformance`,
  `test:conformance` in `test`) runs one set of failing and budget-breaching
  inputs through TypeScript direct and worker execution, the Go SDK, the
  packaged launcher, Chromium, Firefox, and WebKit in both modes, and the Schema
  Studio adapter, against one table whose every departure carries a reason; the
  TypeScript `defaultLimits` are asserted against the contract fixture, and the
  external Deno and Go package consumers must compile the compiler-path fixture
  to identical bytes.
- Browsers: every browser step and each engine driver runs under a labelled
  deadline, the engines run at once, and the driver imports the SDK's types. A
  termination acceptance under COOP/COEP shows that timeout, abort, and dispose
  stop a running guest: Chromium after about 2 s; WebKit only when the guest
  next enters JavaScript, so a Wasm loop is an expected failure until in-guest
  interruption lands. On macOS, WebKit workers run out of stack at about 34
  nested const references and 90 nested imports, and outcomes near that limit
  vary; Linux WebKit and Firefox workers compiled 100 of each.
- Deno: the worker termination probe also spins in Wasm and in a Wasm catch_all
  handler, and `test:termination-canary` (nightly, not a gate) compares the
  worker runtime, the pinned Deno, and the newest release with the recorded
  behavior.
- Tooling: `lint` runs actionlint 1.7.12 (locked); `ci` and the CI check job run
  the Go race tests; `test:package` and `test:launcher` prepare their candidates
  under `build/test` and run on a dirty tree, with the package gates' writes
  confined to `build/`; the wazero test host caches compiled code
  (`test:cli-parity` 80 s to 56 s); `clean:all` runs without Go.

## capnp-wasm-compiler-host

Compiler and TypeScript host for Deno and browser workers: `wasm/capnp.wasm`,
pinned `include/`, built `typescript/mod.js`, `mod.d.ts`, and `worker.js`,
licenses, manifest, and provenance. No language generators, Go SDK, or launcher.

### 0.1.0-rc.3 (2026-09-15)

- `compile` accepts optional `sourcePrefix` and ordered `importPaths`, resolved
  inside the supplied files snapshot; the package gate compares complete
  canonical requests with the native compiler for both include orders
  (`b239a39`).
- Producer build includes the macOS source-archive staging fix for Zig source
  exports (`a5ccaae`). rc.2 remains published unchanged.

### 0.1.0-rc.2 (2026-09-15)

- First compiler-host flavor (`9750812`).
- Worker execution is accepted only on Deno 2.6.8 (`supportedDenoWorkerVersion`)
  because later Deno releases do not stop a terminated worker's execution; other
  versions are rejected before a worker starts, and direct execution is
  unchanged.

## capnp-wasm-tools

Compiler-only toolchain for build systems: `wasm/capnp.wasm`, pinned `include/`,
the `bin/capnp-wasm` Bash launcher for Wasmtime, licenses, manifest, and
provenance. No SDK code or generator modules.

### 0.1.0-rc.2 (2026-09-15)

- First published compiler-only archive with the pinned Wasmtime launcher
  (`0c45c08`); the launcher requires Wasmtime 48.0.1 exactly.

## capnpc-wasm (full SDK archive and Go module)

Unpublished. The archive bundles all six Wasm commands, the TypeScript SDK, the
Go SDK source, standard includes, the launcher, licenses, manifest, and
provenance. Candidates were prepared locally at `0.1.0-rc.1` (commit `94ba6b2`;
receipt in `docs/release-evidence/94ba6b2-private-package.json`) and at
`0.1.0-rc.2` and `0.1.0-rc.3` (the version in `release.json`). No `sdk/go/v*`
tag exists.

## Repository history before the first published asset

Commit subjects between 2026-09-08 and 2026-09-09, in first-parent order, oldest
first:

- `ab91569` pinned toolchains and upstream references; `ffd8aa5` WASI command
  tools; `e1a2c16` Rust and Go generators with runtime parity tests; `a180f06`
  in-memory host SDKs and offline browser verification; `f727fca` saved-request
  generation and all browser engines; `dc8a490` capnp-zig generation across
  hosts and SDKs; `1e095b4` rename to capnpc-wasm.
- `d80fd06` Zig helper-name and double-far list encoding fixes; `a2a18ec` Zig
  reflection and generated API conformance; `81525d2` hardened Zig RPC and
  reflection synced from native sources; `ac9b91e` SDK resource bounds and
  installable package validation; `92d55f3` double-far copy fixes; `41037ae`
  browser engine upgrade and cancellation stress; `dfee5de` native transport
  fixes and browser compatibility notes; `0b4bbf6` Apache-2.0 licensing;
  `894890b` Windows transport repair and release-confidence evidence; `a2326f6`
  Schema Studio; `bee74ef` Studio CI and nightly evidence; `f7c23cc` Windows
  test-runner workaround; `94ba6b2` Windows workflow label correction; `baaac12`
  hosted acceptance and nightly ledger initialization; `b8d8e3f` first scheduled
  nightly confidence cycle.
