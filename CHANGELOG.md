# Changelog

One section per artifact flavor; each flavor has its own version (`versions` in
`release.json`). Dates are the GitHub publication dates (UTC) for published
assets. Archive and manifest digests and producer commits live in
[published releases](docs/releases.md#published-releases). Later work appends
one-line bullets under "Unreleased"; a release copies the bullets that apply to
its flavor under that flavor and version, and a bullet leaves "Unreleased" once
every flavor it applies to has shipped it.

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
- Release evidence: every receipt in `docs/release-evidence/` carries a schema
  version and validates against its type's JSON Schema in `schemas/`
  (`mise run check:evidence`, part of `lint`, which also checks the ledger's
  counters against its cycles and its gitlink against the index); the
  nightly-confidence ledger measures this repository's scheduled `nightly.yml`
  at the `ref/capnp-zig` gitlink (decision D5 = A), ends the streak on any
  re-run, and is regenerated from the GitHub API by `mise run audit:nightly`
  (streak 0 until the held workflow runs from `main`); `mise run test:evidence`
  tests both scripts; the capnp-zig-based ledger is kept as
  `capnp-zig-nightly-confidence.json`.
- Support matrix: per-push claims name only the tested hosts, Linux x64 and
  macOS arm64; the nightly workflow (held until it reaches `main`) tests Linux
  arm64, macOS x64 (`macos-15-intel`), browsers on macOS, and the Go SDK on
  Windows against Linux-built modules with the native-oracle comparisons
  skipped; Node.js and Bun direct execution is best effort, and
  `createWorkerCompiler` rejects Node.js.
- Release versions: each archive flavor has its own version under `versions` in
  `release.json` (`capnpc-wasm` 0.1.0-rc.4, `capnp-wasm-tools` 0.1.0-rc.3,
  `capnp-wasm-compiler-host` 0.1.0-rc.4). `scripts/release.ts` rejects a missing
  or unknown flavor and the old single `version`, and refuses a flavor version
  whose own tag, or for the full SDK the Go module tag `sdk/go/v<version>`,
  exists at another commit, so `release:compiler-host` builds again without
  `--allow-existing-tag`. The launcher's `--version` reads only the packaged
  `package.json`, and the package receipt starts with `schemaVersion: 1` and
  records the tools archive's version.
- Documentation: `docs/api-stability.md` lists the stable and experimental
  interfaces of both SDKs, the archives, and the launcher; states the 0.x
  version rules (a minor release may break, with a CHANGELOG bullet marked
  breaking; a patch release never breaks; `X.Y.Z-rc.N` are candidates of one
  version) and the deprecation window (announced in the CHANGELOG and the
  documentation comment, removed no earlier than the next minor release); and
  records the naming rule: `capnp-wasm-<part>` for compiler-only artifacts,
  `capnpc-wasm` for the full SDK package, its archive, and the Go module tag.
  `docs/sdk-contract.md` now defers to those version rules instead of freezing
  the contract at the first tag.
- Release process: a release bumps only its own flavor's entry in `release.json`
  right after publishing, copies the Unreleased bullets that apply to that
  flavor, and adds one published-releases row per flavor release; the Go module
  tag goes at the commit of the matching `capnpc-wasm` release. Each packaged
  README links the API stability policy at the producer commit.
- Notices and SBOM: every component license in `components.json` is an SPDX
  expression (Rust std `MIT OR Apache-2.0`; wasi-libc
  `(Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT) AND MIT AND BSD-2-Clause AND CC0-1.0 AND BSD-3-Clause`,
  its own code and its portions), with prose in a separate `note` that the
  notices print and the SBOM keeps in `licenseComments`, so the SBOM declares
  every component's license instead of `NOASSERTION`. The gate follows SPDX 2.3
  with allow-listed license and exception identifiers (no `LicenseRef-`,
  `NOASSERTION`, or `NONE`); `build:sdk` only warns, and `test:package`, which
  `ci` and the release workflow run before any upload, fails on a component
  without an accepted expression. The SBOM's `capnpc-wasm` component (the
  project's own code) is versioned by the producer commit, not by the flavor's
  version.
- TypeScript SDK: every guest module is validated and then instrumented when it
  is compiled: one `capnp_wasm.interrupt` import polled from loop headers, from
  the entry of each function that calls guest code, and after each import call,
  including calls through tables and function references, which reach the import
  through an added function that checks after it, with a trap after `proc_exit`;
  bulk memory and table operations are charged by size, and every WASI import
  polls the job before it acts. Function indices and the `name` section's
  function and local names are renumbered, custom sections other than
  `producers` and `target_features` are dropped, and constructs the rewriter
  cannot parse exactly (GC types, table initializers, shared or 64-bit memory
  imports, unknown opcodes) are rejected with `TypeError`. Generated output is
  byte-identical.
- TypeScript SDK: host stops never throw into a guest, where `catch_all` could
  intercept them: `proc_exit`, budget overruns, and host failures inside WASI
  imports or while polling the job (an abort signal whose `aborted` throws)
  record their outcome and trap the guest at its next check, so no guest handler
  or cleanup runs after them (exit codes, messages, and causes are unchanged); a
  stop recorded during a start function keeps `_start` from running.
  `poll_oneoff` sleeps with `Atomics.wait` instead of spinning, reads the
  subscription flags at the WASI offset (absolute clock timeouts), reads the
  whole subscription before writing an event that overlaps it, reports the event
  count, and returns `EINTR` when the job is cancelled.
- TypeScript SDK, breaking: direct `compile` and `generate` now have a deadline.
  They take the worker's `{ signal, timeoutMs }` options (`JobOptions` now lives
  in the shared types), and `timeoutMs` defaults to 30 seconds in both modes, so
  a direct job that runs longer, which the published compiler-host 0.1.0-rc.2
  and rc.3 let run without limit, now rejects with a `TimeoutError` and its
  guest traps; pass a larger `timeoutMs` (at most 2147483647) for longer jobs.
  Invalid options reject with `TypeError` before the request is validated.
- TypeScript SDK: worker cancellation stops the guest inside the worker instead
  of relying on `Worker.terminate()`, which does not stop a running Wasm guest
  in WebKit, Bun, or Deno 2.7.6 and later: a timeout, an abort, or `dispose()`
  rejects at once and traps the guest at its next check through a shared cell
  (where `SharedArrayBuffer` reaches the worker) or the deadline the worker
  enforces itself. A timeout keeps the worker for the next job, and so does an
  abort that reaches the guest through the cell; `dispose()`, and an abort
  without shared memory, terminate the worker, and `terminate()` is otherwise
  only a fallback. Without cross-origin isolation an aborted guest is bounded by
  its `timeoutMs`.
- TypeScript SDK: `createWorkerCompiler` is admitted on every Deno release and
  on Bun (verified locally on 1.3.14, not in CI), where releases without
  standardized Wasm exception handling still fail the engine check; Node.js (no
  Web `Worker`) and unrecognized hosts are still rejected, and
  `isBoundedWorkerSupported()` follows. `supportedDenoWorkerVersion` is
  deprecated, and the SDK no longer checks it; the 2.1 s Deno restart grace is
  gone. The worker tests run on the pinned Deno.
- TypeScript SDK: `CompileError` gains `kind` (`exit`, `trap`, `limit`, or
  `protocol`) and, for budget overruns, `limit` naming the exceeded
  `ResourceLimits` field, typed by the new exports `FailureKind` and
  `CompileErrorOptions`; both fields cross the worker protocol unchanged.
  Classes are unchanged, and so are messages except one: a generated output path
  over `pathBytes` is now a limit like the other running budgets, so its cause
  reads `pathBytes resource limit exceeded` instead of
  `path exceeds pathBytes limit`, as the Go SDK already reported it.
- TypeScript SDK: the pinned WASI shim is imported through one typed facade
  (`shim.ts` with `shim.d.ts`), and
  `deno check --config sdk/typescript/deno.strict.json` type-checks the SDK and
  its tests in strict mode; `deno test` keeps the non-strict `deno.json`,
  because it also type-checks the shim's upstream sources.
- Toolchain: the Deno 2.6.8 worker lane is removed. The `deno-worker` tool and
  its `mise.lock` entries, `deno-worker:install`, and `test:deno-worker` are
  gone, and `ci` no longer runs the lane; the SDK worker tests and the
  compiler-host package gate run on the pinned Deno only, where
  `test:deno-worker-soak` is now `test:sdk-ts-soak`. `test:termination-canary`
  tracks the pinned and the newest Deno, `audit:advisories` no longer queries or
  accepts advisories for 2.6.8, the full SDK and compiler-host package READMEs
  no longer say worker execution requires that release, and `lint` also runs the
  strict SDK type check.
- Toolchain: the pinned Zig development build installs from this repository's
  pre-release `toolchain-zig-0.17.0-dev.1683+5ceec001b` instead of a randomly
  chosen Zig community mirror. `mise.toml` turns the mirrors off and redirects
  core:zig's downloads there with `url_replacements`; mise still verifies the
  ZSF minisign signature and the locked sha256. `mise.lock` names the release
  URLs, `mise run mirror:zig -- verify` checks the lock, the rule, and the
  release against each other, and `check:lock-urls` also checks each Zig
  `.minisig`.

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
`0.1.0-rc.2` and `0.1.0-rc.3`, while one version covered every flavor. Its own
entry in `release.json` is now `0.1.0-rc.4`, a version no candidate has used;
the Go module tag `sdk/go/v<version>` takes the same version. No `sdk/go/v*` tag
exists.

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
