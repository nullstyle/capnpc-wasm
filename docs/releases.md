# Compiler releases and SDK candidates

The public source repository and canonical compiler download host is
[nullstyle/capnpc-wasm](https://github.com/nullstyle/capnpc-wasm). The compiler
archives below are published prereleases; full SDK registry publication and a
stable SDK interface remain pending. `release.json` owns the package name,
version, private registry flag, and project license selection. The `private`
flag prevents accidental npm publication; it does not make GitHub release
downloads private. Project-owned code is licensed under Apache-2.0; upstream
code retains the licenses shipped in `licenses/`, listed per archive in
`THIRD_PARTY_NOTICES.md`. The full SDK archive includes the project license at
`LICENSE` and `sdk/go/LICENSE`.

Releases are built only by the [release workflow](#release-process) from a
clean, tagged commit. Local preparation (`mise run release:*`) produces
candidates for inspection and the package tests; nothing built on a workstation
is uploaded.

## Public compiler downloads

| Package                        | Release                                                                                                  | Host runtime       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------ |
| Compiler and Wasmtime launcher | [0.1.0-rc.2](https://github.com/nullstyle/capnpc-wasm/releases/tag/capnp-wasm-tools-v0.1.0-rc.2)         | Wasmtime 48.0.1    |
| Compiler and TypeScript host   | [0.1.0-rc.3](https://github.com/nullstyle/capnpc-wasm/releases/tag/capnp-wasm-compiler-host-v0.1.0-rc.3) | Deno worker: 2.6.8 |

The earlier
[compiler host rc.2](https://github.com/nullstyle/capnpc-wasm/releases/tag/capnp-wasm-compiler-host-v0.1.0-rc.2)
is also available. All three archives and their `SHA256SUMS` files were first
published on 2026-09-15 on the maintainer's former release host, the
`nullstyle/slcp-zig` repository (SLCP is a consuming application project), and
copied byte for byte to this repository the same day. Versions, archive hashes,
manifests, and embedded provenance are unchanged; the original download URLs on
that host remain available for consumers that already pin them.

Published assets are immutable: changed bytes need a new version. GitHub's
generated source archives are separate from the release assets.

## Published releases

The digests below were read on 2026-09-22 from the GitHub release assets
(`gh release view <tag> --json assets`) so that consumers can pin them
independently of the download host. For these three releases `SHA256SUMS` lists
two lines, the archive and `package/manifest.json`, so `sha256sum -c` needs
`--ignore-missing` before extraction. From the next release on, `SHA256SUMS`
lists the three published assets (`<stem>.tgz`, `<stem>.manifest.json`, and
`<stem>.spdx.json`) and passes on the download directory as is. The
compiler-host manifest digests come from local archives whose bytes match the
published archive digests. No byte-identical local copy of the tools rc.2
archive exists, so its manifest digest is not recorded; the digest of its
`SHA256SUMS` asset, which lists it, is recorded instead. Every release adds a
row here after its draft is verified and before it is published (the
[release process](#release-process) below).

| Release                        | Archive                                                  | Archive SHA-256                                                    | `package/manifest.json` SHA-256                                                                     | Producer commit                            | CI on the producer commit                                                                                                                                                                      |
| ------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools rc.2, 2026-09-15         | `capnp-wasm-tools-0.1.0-rc.2.tgz`, 908,300 bytes         | `84f6dd426dd0e94dd5d7fd3dd0e9390e84905ac4b5e6957af57788967e5065f4` | Not recorded; `SHA256SUMS` asset `510fd723d1ddc48a26e966ae20e3f8790c8f92f61473b5f975a2b381abc25c1d` | `0c45c08aa7a836a09e2d715f790823288769b04c` | Passed ([run 34922318054](https://github.com/nullstyle/capnpc-wasm/actions/runs/34922318054))                                                                                                  |
| Compiler host rc.2, 2026-09-15 | `capnp-wasm-compiler-host-0.1.0-rc.2.tgz`, 944,201 bytes | `5f99f8756070c9eb267160b1af41efe227175ace3e5f751b3a35bb5bb2470b24` | `e84125596f6d26818529f1315ca10875ae99910e35c47f97a27e97a0a2db7bc6`                                  | `97508128435afcc502aab63f1f08a3aa8090a1b7` | Not green: the macos-15 `mise run check` step failed and the other jobs were cancelled by the next push ([run 34933604007](https://github.com/nullstyle/capnpc-wasm/actions/runs/34933604007)) |
| Compiler host rc.3, 2026-09-15 | `capnp-wasm-compiler-host-0.1.0-rc.3.tgz`, 945,229 bytes | `ca8dfa0033e417e1db0522f2d1c28ccfeda4d42c18ae160de3a26d8a763521ec` | `322fa3148ec3cb7e31454b910a5e8d831a3bf1ec2635b5a8c5794c10a66077ce`                                  | `a5ccaae128665914d3878d83908bd5ddbece58ea` | Failed only at `git diff --exit-code` after every check passed on both hosts ([run 34934841115](https://github.com/nullstyle/capnpc-wasm/actions/runs/34934841115)); fixed by `672679a`        |

The full SDK archive (`capnpc-wasm-<version>.tgz`) has never been published.

## Release process

`.github/workflows/release.yml` is the only producer of published assets. It
runs when a tag `capnp-wasm-tools-v<version>`,
`capnp-wasm-compiler-host-v<version>`, or `capnpc-wasm-v<version>` is pushed,
and the tag must name the version in `release.json`. A `workflow_dispatch` run
takes a flavor and performs the same build and checks as a dry run: it uploads
the assets as workflow artifacts and never creates a release, an attestation, or
a tag.

1. Set the version in `release.json`, move the flavor's bullets from
   `## Unreleased` in `CHANGELOG.md` under `## <flavor>` / `### <version>`
   (publish mode refuses a version without that entry), and commit. CI must be
   green for that commit.
2. Push the tag at that commit (an annotated or signed tag; the tag rulesets
   below decide who may create one). The `build` job checks that the commit has
   a successful CI run, or runs `mise run check` itself; builds from the clean
   checkout; runs `scripts/release.ts --publish`, which refuses a dirty tree, a
   `HEAD` that does not carry the tag, and an existing destination; runs
   `test:package`, `test:launcher`, and `test:deno-worker`; and verifies with
   `scripts/verify-release.ts` that the manifest names the tagged commit with
   `dirty: false` and that the archive extracts to exactly that manifest.
3. The `publish` job (tag pushes only, and only if no release exists for the
   tag) re-verifies the uploaded assets, attaches build-provenance and SBOM
   attestations, and creates a **draft prerelease** titled `<flavor> <version>`
   with `<stem>.tgz`, `<stem>.manifest.json`, `<stem>.spdx.json`, and
   `SHA256SUMS`. The notes come from the CHANGELOG entry and the digests, plus
   the workflow and CI run links.
4. Download the draft's assets and verify them as a consumer would (below). Add
   the row to [published releases](#published-releases) in a docs commit, then
   publish the draft. With immutable releases enabled, the assets can no longer
   be changed or deleted.
5. Right after publishing, choose the next version in `release.json` so that
   later candidates never carry a published version; candidate mode refuses a
   version whose tag exists at another commit. The Go module tag
   `sdk/go/v<version>` is created by hand, after the SDK API freeze, and is not
   part of this workflow.

Repository settings that only a human can enable, and that the workflow assumes:
immutable releases (Settings, General); tag rulesets for `capnp-wasm-*`,
`capnpc-wasm-*`, and `sdk/go/*` that restrict creation to maintainers and block
deletion and updates (require signed tags when every maintainer signs); branch
protection on `main` requiring the CI checks; and Actions permissions that allow
the workflow's `contents: write`, `id-token: write`, and `attestations: write`
grants.

To verify a download, check the assets, compare the archive digest with the
[published releases](#published-releases) row (a channel independent of the
release page), verify the provenance, then verify the extracted inventory with
the verifier from a checkout of the repository at the tag rather than the copy
inside the archive:

```sh
sha256sum -c SHA256SUMS
gh attestation verify capnp-wasm-tools-<version>.tgz --repo nullstyle/capnpc-wasm
gh attestation verify capnp-wasm-tools-<version>.spdx.json --repo nullstyle/capnpc-wasm
tar -xzf capnp-wasm-tools-<version>.tgz
deno run --allow-read scripts/verify-release.ts --sums SHA256SUMS \
  --expect-manifest-sha256 <digest from the published releases row> \
  --expect-commit <producer commit> --require-clean ./package
```

`gh attestation verify` checks the Sigstore signature that GitHub's build
provenance attestation carries: the asset was produced by this repository's
release workflow at the tagged commit. `<stem>.spdx.json` is the SPDX 2.3
software bill of materials for the archive: the project, every reference
checkout, Go module, crate, and toolchain runtime the archive's artifacts were
built from, with their commits, versions, and license expressions, plus the tool
pins from `mise.toml`.

## Prepare a local candidate

From the source checkout, run:

```sh
mise run release:prepare
mise run test:package
```

`release:prepare` builds the full SDK candidate, `release:tools` the
compiler-only archive, and `release:compiler-host` the compiler and TypeScript
host archive. The output is under `dist/releases/<stem>/` (for the current
version, `dist/releases/capnpc-wasm-0.1.0-rc.3/`): a `package/` directory, the
npm-compatible `<stem>.tgz` archive, `<stem>.manifest.json` (a copy of
`package/manifest.json`), the `<stem>.spdx.json` SBOM, `<stem>.notes.md`, and
`SHA256SUMS`, which lists the archive, the manifest asset, and the SBOM.
Preparation starts from fresh staging directories and removes stale assets.
Sorted tar entries, fixed permissions, zero ownership, and zero timestamps make
archive bytes reproducible for the same source and built inputs.

`scripts/release.ts` refuses two states that must never reach a release, and
`--allow-dirty` and `--allow-existing-tag` are accepted only in candidate mode:

- A working tree with uncommitted or untracked changes: pass `--allow-dirty` for
  a local experiment (`manifest.json` records `dirty: true`), or commit first.
- A version whose release tag exists at another commit (for example
  `capnp-wasm-compiler-host-v0.1.0-rc.3` at `a5ccaae` while `release.json` still
  says `0.1.0-rc.3`): choose the next version, or pass `--allow-existing-tag`
  for a throwaway candidate. Task arguments pass through, so
  `mise run release:compiler-host -- --allow-existing-tag` works.

`--out <dir>` writes `<dir>/<stem>/` instead of `dist/releases/<stem>/`; the
package tests prepare their candidates under `build/test/` and never touch
`dist/releases/`. `--publish` is the workflow's mode.

`manifest.json` records every package file's length and SHA-256 digest, the
source commit and working-tree state, a complete source digest, and the pinned
reference commits. `provenance/` includes source-file hashes, `mise.toml`,
`mise.lock`, and the exact Go runtime module version, checksum, and Git
revision. `verify-release.ts` (also copied into the package) checks the
extracted inventory and file contents, and its options tie the package to the
published assets and the producer commit:

```sh
deno run --allow-read scripts/verify-release.ts --sums dist/releases/<stem>/SHA256SUMS ./package
```

The manifest detects changed, missing, and unexpected package files. It is not a
digital signature: a party able to replace both artifacts and their manifest can
recompute hashes. Authenticity comes from the release workflow's attestations
and from the digests recorded under published releases.

## Packaged documents and notices

Each archive's `README.md` is generated from
`scripts/templates/README-<flavor>.md` with the version, tag, and producer
commit filled in. It covers verification and usage with package-relative paths
and links to the repository at the producer commit for everything else; it makes
no claims about the project's status. `test:package` and
`test:compiler-host-package` run the README's `ts example` and `sh example`
blocks against the extracted package and check every relative link in the
packaged Markdown. The SDK flavors also ship `docs/typescript.md`, the
TypeScript SDK guide at the producer commit with its relative links rewritten to
the repository at that commit, and the full SDK ships `sdk/go/README.md` the
same way. `THIRD_PARTY_NOTICES.md` at the package root lists the components of
that flavor's artifacts and the texts under `licenses/`, which holds only the
files those components need.

## Repository toolchain launcher

Both archives include `bin/capnp-wasm`, an executable Bash launcher for Wasmtime
(`package.json` also lists it under `bin`). It resolves its package root through
symlinks, from a bare name, and with `CDPATH` set, so it can be linked onto
`PATH` or run as `bash package/bin/capnp-wasm`. The packaged Wasmtime version is
generated from `mise.toml` into `runtime/wasmtime-version`. The launcher accepts
that version, any newer patch release of the same `major.minor` series (with a
one-line warning), or exactly the version named by
`CAPNP_WASM_WASMTIME_ACCEPT_VERSION`; anything else fails before the guest
starts. `CAPNP_WASM_WASMTIME` selects the executable, otherwise `wasmtime` on
`PATH`. Package integrity verification belongs to the consumer's bootstrap step.

```sh
# Stage project schemas and the required bundled includes in a fresh workspace.
mkdir -p /absolute/work/input/include /absolute/work/output
cp -R package/include/. /absolute/work/input/include/
cp project/schema/example.capnp /absolute/work/input/
package/bin/capnp-wasm compiler --workspace /absolute/work/input -- \
  compile --no-standard-import -I/include --src-prefix=/ -o- /example.capnp \
  > /absolute/work/request.bin
package/bin/capnp-wasm generator \
  --module /absolute/path/to/matching-capnpc-zig.wasm \
  --output /absolute/work/output -- < /absolute/work/request.bin
package/bin/capnp-wasm compiler -- convert binary:canonical \
  < /absolute/work/statement.bin > /absolute/work/statement.canonical.bin
```

The compiler runs the packaged `capnp.wasm` with `argv[0]` set to `capnp`, so
its diagnostics suggest `capnp compile --help`; a generator runs with its module
basename (`capnpc-c++`, `capnpc-zig`). Both use guest current directory `/`,
standardized Wasm exception handling, and an empty guest environment. Arguments
after `--` and binary standard streams pass through unchanged. There is no
native compiler fallback and no shell evaluation of arguments.

Inputs are read-only and outputs are transactional:

- `compiler --workspace ABS_DIR` copies the workspace (a clone on APFS and
  reflink filesystems, otherwise a plain copy), removes write permission from
  the copy, and maps only the copy as guest `/`. The original directory is never
  opened by the guest, so it is byte-identical after successful and failed runs.
  The root must be an existing absolute directory; `/` is refused, `$HOME`
  produces a warning, and the copy is limited to 65536 entries and
  `CAPNP_WASM_MAX_WORKSPACE` bytes of disk usage (default 256 MiB). Without
  `--workspace` the guest sees an empty root, which is enough for `convert`,
  `id`, and `--version`. Wasmtime honors host permissions; a root user loses the
  read-only guarantee of the copy.
- `generator --output ABS_DIR` maps an empty staging directory (a hidden sibling
  of the output directory, or a hidden child when the parent is not writable) as
  guest `/`. Files move into `--output` only after the generator exits 0. Before
  the first move, every destination is checked: an existing directory where a
  file belongs, a file where a directory belongs, a read-only file, or a symlink
  at any destination or parent inside `--output`, or a symlink created by the
  generator, fails with exit 73 and leaves the output directory unchanged. A
  failed or interrupted guest run removes the staging directory and writes
  nothing. If a move into `--output` fails part-way (for example after a
  permission change during the run), the launcher exits 73 and keeps the staging
  directory, naming it in the message so the remaining output can be recovered.

Confinement follows Wasmtime's preopen rules. Relative symlinks that resolve
inside the mapped root are followed; absolute symlinks and symlinks that leave
the root fail inside the guest with `Operation not permitted`, and `..` cannot
climb above the root. The launcher warns up front about absolute workspace
symlinks and relative ones that leave the root. Layouts that rely on such links
must be staged with `cp -RL` first. Because the guest reads a real host
directory, behavior follows the host filesystem: imports are case-insensitive on
default macOS volumes but case-sensitive on Linux and in the SDKs, names
containing backslashes are ordinary characters here but rejected by the SDKs,
and path length is bounded by the host `PATH_MAX`. Schemas that build here may
fail in the SDKs or on another host for these reasons.

The guest environment is always empty. `CAPNPC_ZIG_*` variables (for example
`CAPNPC_ZIG_API_PROFILE`) are not forwarded; the launcher prints a one-line
warning when any is set, and the same choices are available as `capnpc-zig`
command-line options. Guests are bounded:

| Bound              | Default                        | Override                                    |
| ------------------ | ------------------------------ | ------------------------------------------- |
| Wasm stack         | 8 MiB (`-W max-wasm-stack`)    | none; sized to the guest's linear stack     |
| Linear memory      | 256 MiB (`-W max-memory-size`) | `CAPNP_WASM_MAX_MEMORY` bytes, 16 MiB-4 GiB |
| Execution time     | 300 s (`-W timeout`)           | `CAPNP_WASM_TIMEOUT` seconds, `0` disables  |
| Workspace copy     | 256 MiB, 65536 entries         | `CAPNP_WASM_MAX_WORKSPACE` bytes            |
| Wasmtime backtrace | 16 frames (`-D max-backtrace`) | none                                        |

The stack bound compiles constant-reference chains 1500 deep, beyond the native
compiler; native Wasmtime defaults trap near 170. Memory exhaustion is reported
by the guest itself (a failed `memory.grow`), so it surfaces as the guest's own
error. Overrides that are not whole numbers in range fail with exit 78. Exit
statuses:

| Exit  | Meaning                                                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Success                                                                                                                                                             |
| 1-63  | Guest exit status, passed through unchanged (`capnp` uses 1 for schema and usage errors)                                                                            |
| 64    | Launcher usage error: unknown mode or option, missing `--`, relative or `::` root, `/` as a root                                                                    |
| 65    | `--module` is not a WebAssembly binary                                                                                                                              |
| 66    | Missing or unreadable workspace, output directory, or module                                                                                                        |
| 69    | Wasmtime executable not found, or its version could not be read                                                                                                     |
| 70    | The launcher cannot resolve its own location (unreadable or overlong symlink chain)                                                                                 |
| 73    | Cannot stage the workspace, or cannot publish generator output (conflict, read-only, symlink, not writable); a move that fails part-way keeps the staging directory |
| 78    | Packaged runtime version missing, Wasmtime version rejected, or an invalid environment override                                                                     |
| 134   | Wasmtime trap: timeout (`wasm trap: interrupt`), stack exhaustion, or a guest fault; the module's basename and a bounded backtrace are printed on stderr            |
| 1     | Wasmtime could not load or instantiate a module whose magic bytes were valid                                                                                        |
| 128+N | The launcher was stopped by signal N after forwarding it to the guest and removing its staging directory                                                            |
| other | Any other failure of one of the launcher's own commands exits with that command's status, usually 1, after its message                                              |

`capnp-wasm --help` prints this contract and `capnp-wasm --version` prints the
package version and the packaged Wasmtime version, both with exit 0.

`mise run test:cli-parity` runs upstream `capnp-test.sh` plus conversion and
eval matrices through the launcher, raw Wasmtime, wazero, and the Deno host,
byte-compared with the native compiler.

`mise run release:tools` prepares
`dist/releases/capnp-wasm-tools-<version>/capnp-wasm-tools-<version>.tgz`. This
smaller archive includes the compiler, standard include schemas, launcher,
runtime version, licenses, and source provenance/integrity inventory. It omits
SDK code and generator modules; repository consumers build generators matching
their own runtime dependency pins. It uses the same `package/` extraction
layout, manifest format, and verification procedure as the complete SDK archive.
The published
[rc.2 compiler-only archive](https://github.com/nullstyle/capnpc-wasm/releases/tag/capnp-wasm-tools-v0.1.0-rc.2)
contains no SDK implementations. The compiler host below is a separate release
flavor.

## Compiler and TypeScript host package

`mise run release:compiler-host` prepares the
`@nullstyle/capnp-wasm-compiler-host` candidate at
`dist/releases/capnp-wasm-compiler-host-<version>/`. This flavor contains
`wasm/capnp.wasm`, the same pinned `include/` tree, built `typescript/mod.js`,
`mod.d.ts`, and `worker.js`, the SDK guide as `docs/typescript.md`, licenses,
and complete integrity/provenance data. It omits language generator modules, the
Go SDK, and the external Wasmtime launcher. The compiler and include bytes match
the compiler-only toolchain archive; TypeScript execution needs no Wasmtime
install.

Import `createCompiler` or `createWorkerCompiler` from the installed package.
Supply the packaged compiler bytes with `generators: {}`, then call
`compile({ files, includeFiles, entrypoints, generators: [] })` to receive
unpacked `CodeGeneratorRequest` bytes. This is the existing SDK API; the package
does not add a TypeScript generator or an `encode`/`decode` command API. All
asset loading belongs to the consumer. After loading bytes and a worker script
into a blob URL, jobs and worker restarts can run without filesystem, network,
or process permission. Keep the blob URL alive until the worker is disposed.
Worker execution requires Deno 2.6.8 and has its documented two-second engine
termination grace; unsupported Deno versions fail before starting a worker.
Direct compilation is also tested on Deno 2.9.6 and has no hard execution
deadline.

The rc.3 compiler host adds optional canonical `sourcePrefix` and ordered
`importPaths` within the supplied files snapshot. The package gate compares
complete canonical requests with the native compiler for both include orders,
including a parent import and binary embed. Existing rc.2 archives remain
immutable; consumers opt into the new version with new integrity pins.

`mise run test:compiler-host-package` prepares its candidate under
`build/test/compiler-host/` and checks reproducibility, the three-asset
`SHA256SUMS` and the verifier options, complete extracted contents, the flavor's
notices, the packaged links and README example, modified/missing/extra-file
rejection, and an external npm-layout Deno consumer with a fresh cache. It
checks direct/worker request parity, imports and binary embeds, diagnostics,
limits, active-guest cancellation, and recovery after restarting the worker
offline on Deno 2.6.8. The default producer-runtime check instead verifies
direct compilation and actionable worker-version rejection. On the supported
Deno, an eight-second parent bound also encloses a real shared counter probe
that confirms execution stops within the engine grace. To test another installed
Deno without changing the producer pin:

```sh
mise exec -- deno run --allow-read --allow-write=build \
  --allow-run=deno,cmake,build/native/bin/normalize-request,build/native/bin/capnp,/absolute/path/to/deno \
  scripts/test-compiler-host-package.ts /absolute/path/to/deno
```

The receipt is written to
`build/test/compiler-host-package-<deno-version>.json`. Compiler host rc.2 and
rc.3 are published at the links above.

## Deno and npm-compatible JavaScript

The archive contains ESM `typescript/mod.js`, its TypeScript declarations,
`typescript/worker.js`, all six Wasm commands, standard schemas, licenses, and a
source copy of the Go SDK. No runtime import points back into the source
checkout. The package exports its main module, `./worker`, `./wasm/*`, and
`./include/*`. It has no JavaScript package dependencies.

An npm-compatible package manager can install the local `.tgz` file. With the
package installed, import `createCompiler` or `createWorkerCompiler` from
`@nullstyle/capnpc-wasm`. Alternatively, Deno can import the extracted
`typescript/mod.js` directly, as the packaged `README.md` example does. Load
module and schema bytes from the extracted package's `wasm/` and `include/`
directories using application-owned URLs or file reads. Browsers should use the
worker entrypoint and keep its URL available for cancellation/restart. Modules
must be supplied as original byte arrays so the SDK can enforce its configured
memory ceiling.

## Go module

The import path is `github.com/nullstyle/capnpc-wasm/sdk/go`, normally aliased
as `capnpcwasm`. Its `go.mod` requires the exact public wazero pseudo-version
matching the repository's unchanged `ref/wazero` gitlink, with checksums in
`go.sum`. It has no dependency on a sibling `ref/` checkout and needs no wazero
replacement. The full SDK archive ships every non-test `.go` file of the module.

Until a Go module version is published, point only the SDK module at the source
included in this candidate:

```sh
go mod edit -require=github.com/nullstyle/capnpc-wasm/sdk/go@v0.0.0
go mod edit -replace=github.com/nullstyle/capnpc-wasm/sdk/go=/absolute/path/package/sdk/go
go mod tidy
```

Supply `package/wasm/*.wasm` and any required `package/include/` schema bytes to
the SDK. The eventual nested module tag must use the `sdk/go/v` prefix (for
example `sdk/go/v0.1.0-rc.3`). Preparing a candidate does not create that tag or
publish the npm package.

## Acceptance checks

`test:package` prepares the full SDK and tools-only candidates under
`build/test/package/`, twice each, and checks identical archive and SBOM bytes;
verifies `SHA256SUMS` with `sha256sum -c` on the candidate directory and with
`verify-release.ts --sums`, `--expect-manifest-sha256`, `--expect-commit`, and
`--require-clean`; checks that publish mode refuses the candidate flags and an
untagged `HEAD`; extracts into a fresh directory under `build/test/`, checks the
packaged links, notices, and every non-test Go source, runs the README examples,
then runs an actual Deno consumer through the installed package's npm-style
exports with strict TypeScript checking, and runs a separate Go module against
the included SDK. Both compile a schema and generate C++, Rust, Go, and Zig from
the packaged assets. The Go consumer resolves wazero from its checksum-pinned
public module version, with no replacement for that dependency. Negative
controls modify a manifest digest and add a stale file; verification must reject
both. Both extracted launchers execute the real compiler and C++/Zig generators,
preserve binary requests and canonicalization bytes, accept paths with spaces,
and reject malformed inputs, invalid roots, and missing or mismatched runtimes.

Hosted browser/platform checks, nightly fuzz/soak evidence, and application
validation remain release gates. Successful local packaging alone does not
establish production maturity.
