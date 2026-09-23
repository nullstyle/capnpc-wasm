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

Commit subjects between 2026-09-08 and 2026-09-09, in order:

- `ab91569` pinned toolchains and upstream references; `ffd8aa5` WASI command
  tools; `e1a2c16` Rust and Go generators with runtime parity tests; `a180f06`
  in-memory host SDKs and offline browser verification; `f727fca` saved-request
  generation and all browser engines; `dc8a490` capnp-zig generation across
  hosts and SDKs; `1e095b4` rename to capnpc-wasm.
- `d80fd06` Zig helper-name and double-far list encoding fixes; `a2a18ec` and
  `81525d2` Zig reflection, generated API conformance, and hardened RPC synced
  from native sources; `ac9b91e` SDK resource bounds and installable package
  validation; `92d55f3` double-far copy fixes; `41037ae` browser engine upgrade
  and cancellation stress; `dfee5de`, `894890b`, `f7c23cc`, `94ba6b2` native
  transport and Windows test-runner syncs; `0b4bbf6` Apache-2.0 licensing;
  `a2326f6` Schema Studio; `bee74ef`, `baaac12`, `b8d8e3f` CI, package, and
  nightly evidence records.
