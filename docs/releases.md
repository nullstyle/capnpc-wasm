# Private release candidates

Version `0.1.0-rc.1` is an installable candidate for testing. It is not a
published release or a promise of a stable SDK interface. `release.json` owns
the package name, version, private flag, and project license selection.
Candidates currently remain private and `UNLICENSED` until the project owner
selects a license; upstream code retains the licenses shipped in `licenses/`.

From the source checkout, run:

```sh
mise run release:prepare
mise run test:package
```

The output is under `dist/releases/capnpc-wasm-0.1.0-rc.1/`: a `package/`
directory, the npm-compatible `capnpc-wasm-0.1.0-rc.1.tgz` archive, and
`SHA256SUMS`. Preparation starts from fresh staging directories and removes
stale assets. Sorted tar entries, fixed permissions, zero ownership, and zero
timestamps make archive bytes reproducible for the same source and built inputs.

`manifest.json` records every package file's length and SHA-256 digest, the
source commit and working-tree state, a complete source digest, and the pinned
reference commits. `provenance/` includes source-file hashes, `mise.toml`,
`mise.lock`, and the exact Go runtime module version, checksum, and Git
revision. A dirty checkout is identified explicitly; rerun preparation after the
final commit to create a candidate tied to that clean commit.

Compare `SHA256SUMS` through your trusted delivery channel before using an
archive. After extraction, verify its complete inventory and file contents:

```sh
deno run --allow-read ./package/verify-release.ts ./package
```

The manifest detects changed, missing, and unexpected package files. It is not a
digital signature: a party able to replace both artifacts and their manifest can
recompute hashes. Release signing and registry publication are separate future
actions.

## Deno and npm-compatible JavaScript

The archive contains ESM `typescript/mod.js`, its TypeScript declarations,
`typescript/worker.js`, all six Wasm commands, standard schemas, licenses, and a
source copy of the Go SDK. No runtime import points back into the source
checkout. The package exports its main module, `./worker`, `./wasm/*`, and
`./include/*`. It has no JavaScript package dependencies.

An npm-compatible package manager can install the local `.tgz` file. With the
package installed, import `createCompiler` or `createWorkerCompiler` from
`@nullstyle/capnpc-wasm`. Alternatively, Deno can import the extracted
`typescript/mod.js` directly. Load module and schema bytes from the extracted
package's `wasm/` and `include/` directories using application-owned URLs or
file reads. Browsers should use the worker entrypoint and keep its URL available
for cancellation/restart. Modules must be supplied as original byte arrays so
the SDK can enforce its configured memory ceiling.

## Go module

The import path is `github.com/nullstyle/capnpc-wasm/sdk/go`, normally aliased
as `capnpcwasm`. Its `go.mod` requires the exact public wazero pseudo-version
matching the repository's unchanged `ref/wazero` gitlink, with checksums in
`go.sum`. It has no dependency on a sibling `ref/` checkout and needs no wazero
replacement.

Until a Go module version is published, point only the SDK module at the source
included in this candidate:

```sh
go mod edit -require=github.com/nullstyle/capnpc-wasm/sdk/go@v0.0.0
go mod edit -replace=github.com/nullstyle/capnpc-wasm/sdk/go=/absolute/path/package/sdk/go
go mod tidy
```

Supply `package/wasm/*.wasm` and any required `package/include/` schema bytes to
the SDK. The eventual nested module tag must use the `sdk/go/v` prefix (for
example `sdk/go/v0.1.0-rc.1`). Preparing a candidate does not create that tag or
publish the npm package.

## Acceptance checks

`test:package` verifies the archive and manifest, extracts into a fresh
temporary workspace outside this checkout, runs an actual Deno consumer through
the installed package's npm-style exports with strict TypeScript checking, and
runs a separate Go module against the included SDK. Both compile a schema and
generate C++, Rust, Go, and Zig from the packaged assets. The Go consumer
resolves wazero from its checksum-pinned public module version, with no
replacement for that dependency. Negative controls modify a manifest digest and
add a stale file; verification must reject both. The test also prepares the same
input twice and checks identical archive hashes.

Hosted browser/platform checks, nightly fuzz/soak evidence, and application
validation remain release gates. Successful local packaging alone does not
establish production maturity.
