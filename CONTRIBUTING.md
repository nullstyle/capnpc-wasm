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

| Changed area                                                                                      | Run before committing                                                                                                     |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| C++ port: `patches/capnproto/`, `cmake/`, `scripts/build-wasm.sh`                                 | `mise run test`                                                                                                           |
| Generator wrappers and consumers: `generators/`, `tests/consumers/`                               | `mise run test`                                                                                                           |
| Zig reference or mirrored fixtures: `ref/capnp-zig`, `generators/zig/sync.json`                   | `mise run build:zig` (runs `check:zig-sync`), then `mise run test`                                                        |
| TypeScript SDK: `sdk/typescript/`                                                                 | `mise run test`, `mise run test:browser`, and the Deno 2.6.8 lane below                                                   |
| Go SDK: `sdk/go/`                                                                                 | `mise exec -- go -C sdk/go test -count=1 -mod=readonly ./...` and `mise exec -- go -C sdk/go vet -stdmethods=false ./...` |
| Schema Studio: `examples/browser/`, `scripts/build-studio.ts`, `scripts/serve-example.ts`         | `mise run test:studio`                                                                                                    |
| Packaging: `scripts/release.ts`, `bin/capnp-wasm`, `docs/releases.md`, `sdk/typescript/README.md` | `mise run test:package`, `mise run test:launcher`, `mise run test:compiler-host-package`                                  |
| Development runners: `tests/hosts/`                                                               | `mise run test`                                                                                                           |
| Markdown                                                                                          | `mise exec -- deno fmt --check <files>` and `mise exec -- deno run --allow-read scripts/check-links.ts`                   |
| Anything, before a pull request                                                                   | `mise run check`, then `git diff --exit-code`                                                                             |

`mise run check` builds everything and runs the whole suite. To iterate on one
suite after `mise run build`, run one of the `run` lines of `[tasks.test]` in
`mise.toml`.

## Reproducing the CI lanes

`.github/workflows/ci.yml` runs on every push and pull request to `main`. It
restores no build cache, so it also exercises bootstrap from the lockfile.
Failing fixtures under `build/test/` are uploaded as workflow artifacts.

Clean checkout (ubuntu-24.04 and macos-15):

```sh
mise run setup
mise run check
mise run test:package
mise --cd "$(mktemp -d)" install deno@2.6.8
mise exec deno@2.6.8 -- deno test --config sdk/typescript/deno.json --unstable-sloppy-imports --allow-read sdk/typescript/sdk_test.ts
mise exec -- deno run --allow-read --allow-write --allow-run scripts/test-compiler-host-package.ts "$(mise where deno@2.6.8)/bin/deno"
git diff --exit-code
```

Browsers (ubuntu-24.04):

```sh
mise exec -- deno run --config tests/browser/deno.json --frozen --allow-read --allow-env --allow-sys --allow-run --allow-net tests/browser/playwright.ts install-deps chromium firefox webkit
mise exec -- deno test --config tests/browser/deno.json --frozen --no-prompt --allow-read --allow-env --allow-sys tests/browser/playwright_test.ts
mise run browser:install chromium firefox webkit
mise run test:browser chromium firefox webkit
mise run test:studio chromium firefox webkit
```

## Updating tools and references

### Tool pins

1. Edit the version in `mise.toml` `[tools]`.
2. Run `mise install`, then `mise lock`, and review the `mise.lock` diff. Keep
   all four `lockfile_platforms` entries; installing an extra tool inside the
   project can prune the other platforms' WASI SDK entries (see the comment in
   `ci.yml`), which is why CI installs Deno 2.6.8 with `--cd` elsewhere.
3. Run `mise run check`.

Zig must equal the `zig` line of `ref/capnp-zig/mise.toml` (both are
`0.17.0-dev.1683+5ceec001b` today). The Wasmtime pin is copied into every tools
archive as the required runtime version, so bumping it changes the launcher
contract for consumers. The Deno pin is the direct-execution version; the worker
version, 2.6.8, is set separately in `sdk/typescript/worker-client.ts` and in
`ci.yml`.

### Reference bump checklist

For every reference under `ref/`:

1. `git -C ref/<name> fetch origin` and `git -C ref/<name> checkout <commit>`,
   then review the upstream changes between the old and new commits.
2. `git add ref/<name>` records the gitlink; `mise run refs:status` shows it.
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
  module with the checkout, so set their `require` line to the new
  pseudo-version (`v3.1.0-alpha.2.0.<UTC commit time>-<12-character commit>`, or
  whatever the new base tag implies) and run `mise exec -- go -C <dir> mod tidy`
  in both directories; builds use `-mod=readonly`.
- `capnp-zig`, in this order: (a) if `ref/capnp-zig/mise.toml` changed its `zig`
  line, bump the tool pin as above; (b) run `mise run build:zig`, which fails in
  `check-zig-sync.ts` because the exported tree no longer matches
  `generators/zig/sync.json`; (c) record the new manifest from the clean
  checkout:

  ```sh
  mise exec -- deno run --allow-read --allow-write=generators/zig/sync.json \
    --allow-run=git scripts/check-zig-sync.ts --record-native ref/capnp-zig
  ```

  Record mode verifies the mirrored fixtures against the native commit and stops
  at the first `Fixture differs from native: <path>`. Copy that fixture from the
  `native` path listed in `sync.json` to its mirrored `path`, and record again
  until it succeeds; (d) run `mise run test` (the reflection, generator API, RPC
  codegen, wire, feature corpus, SDK, and browser suites all consume Zig
  output), and `mise run test:browser`; (e) leave
  `generators/zig/historical-reference` unchanged; it pins the wire suite's
  oracle.
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
  `mise run test`, and update `patches/capnproto/README.md`.
- `WASI`: documentation only.
- Playwright engines are not a gitlink: bump `playwright` in
  `tests/browser/deno.json` and `deno.lock`, run `mise run browser:install`,
  `mise run test:browser`, and `mise run test:studio`, and update the engine
  table in `tests/browser/README.md`.

## Documentation

- Keep each fact in one place: gate status in `docs/release-readiness.md`,
  published digests in `docs/releases.md`, shipped changes in `CHANGELOG.md`,
  and index every new document in `docs/README.md`. A document that stops being
  maintained moves to `docs/history/` with a dated banner.
- `docs/releases.md` and `sdk/typescript/README.md` are copied into release
  archives verbatim; editing them changes packaged bytes.
- Format with `deno fmt` and run `scripts/check-links.ts` before committing.
