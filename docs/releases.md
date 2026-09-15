# Private release candidates

Version `0.1.0-rc.2` is an installable candidate for testing. It is not a
published release or a promise of a stable SDK interface. `release.json` owns
the package name, version, private flag, and project license selection.
Project-owned code is licensed under Apache-2.0. Candidates remain private;
upstream code retains the licenses shipped in `licenses/`. The archive includes
the project license at `LICENSE` and `sdk/go/LICENSE`.

From the source checkout, run:

```sh
mise run release:prepare
mise run test:package
```

The output is under `dist/releases/capnpc-wasm-0.1.0-rc.2/`: a `package/`
directory, the npm-compatible `capnpc-wasm-0.1.0-rc.2.tgz` archive, and
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

## Repository toolchain launcher

Both archives include `bin/capnp-wasm`, a Bash launcher for Wasmtime. Its
required version is generated from `mise.toml` into `runtime/wasmtime-version`;
consumers install that exact Wasmtime version. The launcher accepts
`CAPNP_WASM_WASMTIME` as a single executable path, or finds `wasmtime` on
`PATH`. A missing or mismatched runtime fails immediately. Package integrity
verification belongs to the consumer's bootstrap step.

```sh
# Stage project schemas and the required bundled includes in a fresh workspace.
mkdir -p /absolute/work/input/include /absolute/work/output
cp -R package/include/. /absolute/work/input/include/
cp project/schema/example.capnp /absolute/work/input/
bash package/bin/capnp-wasm compiler --workspace /absolute/work/input -- \
  compile --no-standard-import -I/include --src-prefix=/ -o- /example.capnp \
  > /absolute/work/request.bin
bash package/bin/capnp-wasm generator \
  --module /absolute/path/to/matching-capnpc-zig.wasm \
  --output /absolute/work/output -- < /absolute/work/request.bin
bash package/bin/capnp-wasm compiler --workspace /absolute/work/input -- \
  convert binary:canonical < /absolute/work/statement.bin \
  > /absolute/work/statement.canonical.bin
```

The compiler receives only the workspace as guest `/`; the generator receives
only its output directory as guest `/`. Both explicitly use guest current
directory `/` and standardized Wasm exception handling. Filesystem roots must be
existing absolute directories without Wasmtime's `::` mapping delimiter.
Generator modules must be absolute readable files. Arguments after `--` and
binary standard streams pass through unchanged; the launcher preserves command
exit statuses. There is no native compiler fallback or shell evaluation of
arguments. These filesystem mappings are capabilities, not read-only mounts; use
disposable workspaces and commit generated output only after success.

`mise run release:tools` prepares
`dist/releases/capnp-wasm-tools-0.1.0-rc.2/capnp-wasm-tools-0.1.0-rc.2.tgz`.
This smaller archive includes the compiler, standard include schemas, launcher,
runtime version, licenses, and source provenance/integrity inventory. It omits
SDK code and generator modules; repository consumers build generators matching
their own runtime dependency pins. It uses the same `package/` extraction
layout, manifest format, and verification procedure as the complete SDK archive.
Both candidates remain private until a separate publication decision.

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
example `sdk/go/v0.1.0-rc.2`). Preparing a candidate does not create that tag or
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
input twice and checks identical archive hashes for both archive variants. Both
extracted launchers execute the real compiler and C++/Zig generators, preserve
binary requests and canonicalization bytes, accept paths with spaces, and reject
malformed inputs, invalid roots, and missing or mismatched runtimes.

Hosted browser/platform checks, nightly fuzz/soak evidence, and application
validation remain release gates. Successful local packaging alone does not
establish production maturity.
