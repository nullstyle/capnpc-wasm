# Contributing

## Setup

Follow the [bootstrap](README.md#bootstrap): `mise install`, `mise run setup`,
then `mise run check`. Run every tool from the repository root through
`mise run` or `mise exec --`. Linux hosts need a C++ toolchain and `pkg-config`
(CI installs `g++-14 pkg-config` on ubuntu-24.04); macOS needs the Xcode Command
Line Tools. The [architecture page](docs/architecture.md) explains the pipeline
and which directory owns each stage; [AGENTS.md](AGENTS.md) lists the
conventions in their shortest form.

## Commit style

Conventional commits: `type(scope): imperative summary`, with the summary under
72 characters and a body that says why and what was verified. History uses the
types `feat`, `fix`, and `docs` with the scopes `compiler`, `build`, `ci`, and
`release`; use `test`, `ci`, `build`, or `chore` as types and `sdk`, `sdk-go`,
or `studio` as scopes for those areas, and omit the scope for repository-wide
changes. Examples from history:
`feat(compiler): preserve ordered import roots and source prefixes`,
`fix(ci): isolate the compatibility runtime installation from the lockfile`,
`docs: establish public compiler release hosting`.

## Verifying a change

| Changed area                                                                                      | Run before committing                                                                           |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| C++ port: `patches/capnproto/`, `cmake/`, `scripts/build-wasm.sh`                                 | `mise run test`                                                                                 |
| Generator wrappers and consumers: `generators/`, `tests/consumers/`                               | `mise run test`                                                                                 |
| Zig reference or mirrored fixtures: `ref/capnp-zig`, `generators/zig/sync.json`                   | `mise run build:zig` (runs `check:zig-sync`), then `mise run test`                              |
| TypeScript SDK: `sdk/typescript/`                                                                 | `mise run test`, `mise run test:browser`, and `mise run test:deno-worker`                       |
| Go SDK: `sdk/go/`                                                                                 | `mise run test:sdk-go` and `mise run test:sdk-go-race` (`mise run lint` runs the vet)           |
| Schema Studio: `examples/browser/`, `scripts/build-studio.ts`, `scripts/serve-example.ts`         | `mise run test:studio-unit`, then `mise run test:studio`                                        |
| Packaging: `scripts/release.ts`, `bin/capnp-wasm`, `docs/releases.md`, `sdk/typescript/README.md` | `mise run test:package`, `mise run test:launcher`, `mise run test:compiler-host-package`        |
| Release evidence: `docs/release-evidence/`, `scripts/check-evidence.ts`, and `audit-nightly.ts`   | `mise run test:evidence` and `mise run check:evidence` (`lint` runs it)                         |
| Development runners: `tests/hosts/`                                                               | `mise run test`                                                                                 |
| Markdown                                                                                          | `mise run check:links` and `mise exec -- deno fmt --check <files>`; `mise run lint` covers both |
| Anything, before a pull request                                                                   | `mise run check`, then `git diff --exit-code`                                                   |

`mise run check` runs `lint`, `doctor`, and `test`. `test` fans out to one
`test:<suite>` task per suite (`mise tasks ls` lists them), each depending only
on the build outputs it reads, so `mise run test:<suite>` builds what that suite
needs and `mise run --skip-deps test:<suite>` reruns it without rebuilding.
`mise run fmt` applies every formatter that `lint` checks.

## Reproducing the CI lanes

`.github/workflows/ci.yml` runs on every push and pull request to `main`. It
restores no build cache, so it also exercises bootstrap from the lockfile.
Failing fixtures under `build/test/` are uploaded as workflow artifacts.

Clean checkout (ubuntu-24.04 and macos-15):

```sh
mise run setup
mise run check
mise run test:package
mise run test:deno-worker
test -z "$(git status --porcelain)"
```

`mise install` and `mise uninstall` run from the project root rewrite
`mise.lock`; `deno-worker:install`, which `test:deno-worker` depends on, runs
`mise install --locked deno-worker`, which never rewrites it, and checks the
binary against `sdk/typescript/environment.ts`.

Browsers (ubuntu-24.04):

```sh
mise exec -- deno run --config tests/browser/deno.json --frozen --allow-read --allow-env --allow-sys --allow-run --allow-net tests/browser/playwright.ts install-deps chromium firefox webkit
mise run test:browser-bootstrap
mise run browser:install chromium firefox webkit
mise run test:browser chromium firefox webkit
mise run test:studio chromium firefox webkit
```

## Updating tools and references

### Tool pins

1. Edit the version in `mise.toml` `[tools]`.
2. Run `mise install`, then `mise lock <tool>` for that tool only (a full
   `mise lock` also re-resolves the conda packages), and review the `mise.lock`
   diff. Keep `lockfile_version = 1` (CI's mise 2026.9.1 cannot read version 2)
   and all four `lockfile_platforms` entries; a plain `mise install` of an extra
   tool inside the project can prune the other platforms' WASI SDK entries (see
   the comment in `ci.yml`), which is why CI installs Deno 2.6.8 with `--cd`
   elsewhere and `deno-worker:install` passes `--locked`.
3. Run `mise run check`.

Zig must equal the `zig` line of `ref/capnp-zig/mise.toml` (both are
`0.17.0-dev.1683+5ceec001b` today). ziglang.org no longer lists that development
build: mise installs it from the Zig community mirrors and checks the sha256
that `mise.lock` records with minisign provenance, so after a Zig bump run
`mise lock zig`, then `mise run mirror:zig -- lock --write`, which records the
checksums from signature-verified downloads. The Wasmtime pin is copied into
every tools archive as the required runtime version, so bumping it changes the
launcher contract for consumers. The Deno pin is the direct-execution version;
the worker version, 2.6.8, is the locked tool `deno-worker` in `mise.toml`,
which must equal `supportedDenoWorkerVersion` in `sdk/typescript/environment.ts`
and the version `ci.yml` installs.

### Reference bump checklist

For every reference under `ref/`:

1. `git -C ref/<name> fetch origin` and `git -C ref/<name> checkout <commit>`,
   then review the upstream changes between the old and new commits.
2. `git add ref/<name>` stages the gitlink; `mise run refs:status` shows it. The
   build scripts and `doctor` read the recorded revision from the index
   (`scripts/lib/refs.sh`) and require the checkout to be clean at it, so stage
   the bump before building.
3. Run the area's verification from the table above, then `mise run check`.
4. When generated code or its runtime requirement changes, update the runtime
   tables in [README.md](README.md#generated-code-runtime-requirements) and
   [generators/README.md](generators/README.md#generated-code-runtime-requirements)
   and add a bullet under "Unreleased" in [CHANGELOG.md](CHANGELOG.md).

`scripts/release.ts` records every gitlink in the archive manifest and refuses
to package when a checkout differs from its gitlink.

Per reference:

- `capnproto`: `patches/capnproto/0001-wasi-command-tools.patch` must still
  apply (`scripts/build-wasm.sh` runs `git apply --check` on a fresh source
  copy); update the revision named in `patches/capnproto/README.md`. Native
  tools, the `normalize-request` oracle, the C++ consumers, and the standard
  include schemas copied into `dist/include/` all come from this checkout.
- `capnproto-rust`: change `=0.27.0` in `generators/rust/Cargo.toml` and
  `=0.27.2` in `tests/consumers/rust/Cargo.toml` to the new crate versions,
  refresh both `Cargo.lock` files
  (`mise exec -- cargo update --manifest-path <Cargo.toml>`), and rebuild with
  `mise run build:rust`, which uses `--locked` and fails on a stale lockfile.
- `go-capnp`: `generators/go/go.mod` and `tests/consumers/go/go.mod` replace the
  module with the `ref/go-capnp` checkout, which `build:go` and `doctor` require
  to be clean at the staged gitlink, so their `require` lines name only the
  upstream base tag (`v3.1.0-alpha.2` today). Change that version only when the
  new commit follows a newer upstream tag, then run
  `mise exec -- go -C <dir> mod tidy` in both directories so `go.sum` matches;
  builds use `-mod=readonly`.
- `capnp-zig`, in this order: (a) if `ref/capnp-zig/mise.toml` changed its `zig`
  line, bump the tool pin as above, then run `mise lock zig` and
  `mise run mirror:zig -- lock --write`; (b) with the new gitlink staged, run
  `mise run build:zig`, which exports the tree at the gitlink and fails in
  `check-zig-sync.ts` for every mirrored fixture that differs from its native
  file; (c) refresh the mirrors from the gitlink and review the diff:

  ```sh
  mise exec -- deno run --allow-read --allow-write=tests --allow-run=git \
    scripts/check-zig-sync.ts --update-fixtures
  ```

  `generators/zig/sync.json` only maps native fixture paths to their mirrors
  (add an entry for a new fixture); every expectation comes from the reference
  commit itself; (d) run `mise run test` (the reflection, generator API, RPC
  codegen, wire, feature corpus, SDK, and browser suites all consume Zig
  output), and `mise run test:browser`; (e) leave
  `generators/zig/historical-reference` unchanged; it pins the wire suite's
  oracle; (f) run `mise run audit:nightly` and commit the regenerated
  `docs/release-evidence/nightly-confidence.json`: the bump restarts the nightly
  streak, and `check:evidence` fails until the ledger names the new gitlink.
- `wazero`: `sdk/go/go.mod` must require the pseudo-version of the new gitlink
  (`mise exec -- go -C sdk/go get github.com/tetratelabs/wazero@<commit>` then
  `mise exec -- go -C sdk/go mod tidy`); `tests/hosts/wazero` replaces the
  module with the checkout. `scripts/release.ts` fails when the pseudo-version
  and the gitlink disagree.
- `browser_wasi_shim`: the SDK imports its source directly; run `mise run test`
  and `mise run test:browser`, and confirm the two runtime adaptations in
  `sdk/typescript/runtime.ts` (`path_readlink` errno values and UTF-8 `args_get`
  sizing) still apply.
- `wasi-sdk`: the gitlink documents the installed SDK release, whose version is
  the `[tools.wasi-sdk]` pin in `mise.toml`; bump both together, rerun
  `mise run test`, and update `patches/capnproto/README.md`. Refresh
  `third_party/wasi-sdk-34/` with the steps in
  [its README](third_party/wasi-sdk-34/README.md) (new nested commits, texts,
  digests, directory name); `scripts/package-assets.ts` fails until the manifest
  matches the pin and gitlinks.
- `WASI`: documentation only.
- Playwright engines are not a gitlink: bump `playwright` in
  `tests/browser/deno.json` and `deno.lock`, print the new archive digests with
  `mise run browser:install -- --print-digests` on each platform, confirm each
  against a second download, and record them in `tests/browser/install.ts`; then
  run `mise run browser:install`, `mise run test:browser`, and
  `mise run test:studio`, and update the engine table in
  `tests/browser/README.md`.

## Documentation

- Keep each fact in one place: gate status in `docs/release-readiness.md`,
  published digests in `docs/releases.md`, shipped changes in `CHANGELOG.md`,
  and index every new document in `docs/README.md`. A document that stops being
  maintained moves to `docs/history/` with a dated banner.
- `docs/releases.md` and `sdk/typescript/README.md` are copied into release
  archives verbatim; editing them changes packaged bytes.
- Format the files you touched with `deno fmt` and run `mise run check:links`
  before committing; `mise run lint` checks both.
