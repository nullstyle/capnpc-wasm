# Working in capnpc-wasm

capnpc-wasm ports the Cap'n Proto compiler and the C++, Rust, Go, Zig, and
schema-inspection generators to WASI Preview 1 command modules, and ships
TypeScript and Go SDKs that run them in browsers, Deno, and wazero.
[docs/release-readiness.md](docs/release-readiness.md) is the single record of
release status; update it instead of restating status here.

## Read first

- [README.md](README.md): bootstrap, build, consumer quick start, support
  matrix, generated-code runtime requirements, repository layout.
- [CONTRIBUTING.md](CONTRIBUTING.md): commit style, which task verifies which
  area, reproducing the CI lanes, and the reference bump checklist.
- [docs/README.md](docs/README.md): index of current docs and history.
  [docs/architecture.md](docs/architecture.md) shows the data flow;
  [docs/threat-model.md](docs/threat-model.md) states the trust boundaries.
- Area guides, read before touching the area:
  [patches/capnproto/README.md](patches/capnproto/README.md) for the C++ port
  and Wasm feature profile; [generators/README.md](generators/README.md) and
  [generators/zig/README.md](generators/zig/README.md) for generators;
  [sdk/typescript/README.md](sdk/typescript/README.md) and
  [sdk/go/README.md](sdk/go/README.md) for host integration;
  [tests/browser/README.md](tests/browser/README.md) for browser setup;
  [examples/browser/README.md](examples/browser/README.md) for Schema Studio;
  [docs/releases.md](docs/releases.md) for packaging;
  [ref/README.md](ref/README.md) for upstream entry points.

## Rules

- Run tools from the repository root through `mise run` or `mise exec --`;
  running mise inside `ref/` activates that upstream's own configuration.
- Keep `ref/` pristine at the recorded gitlinks. Project patches and wrappers
  live outside the submodules and apply to disposable copies under `build/`.
- Tool pins live in `mise.toml`, resolved metadata in `mise.lock`, upstream
  revisions in gitlinks. After changing a pin, regenerate the lockfile and run
  `mise run check`. Keep the Zig pin equal to `ref/capnp-zig/mise.toml`. Native
  Clang builds native tools; the WASI SDK Clang stays off `PATH`.
- Preserve the standard binary `CodeGeneratorRequest` boundary with host
  orchestration of generators, WASI Preview 1 command modules (`wasm32-wasip1`),
  standardized Wasm exception handling, and error propagation. Hosts keep
  byte-oriented workspaces, fresh guest instances, read-only inputs, and
  transactional outputs. Cancellation terminates guest execution; a rejected
  promise alone is insufficient.
- The [schema feature corpus](tests/fixtures/features/README.md) is shared by
  the TypeScript, Go, and browser tests. Read embeds as bytes; compare the
  complete canonical request and every generated source byte with native output
  when adding schema coverage.
- Test harnesses under `tests/hosts/` stay separate from the SDKs.
- Generated files and build trees go under `build/`, distributable output under
  `dist/`, caches under `.cache/`, ad-hoc probes under `build/scratch/`.
- Maintain these instructions when a convention changes.

## Verification by area

`mise run check` runs `lint` (static checks with no build), `doctor`, and `test`
(the parity, Zig, SDK, and feature-corpus suites, one `test:<suite>` task each,
building only what it reads). `test:browser`, `test:studio`, `test:package`,
`test:launcher`, and the Deno 2.6.8 worker lane are separate and run only when
named. The CI clean-checkout job (setup, `check`, `test:package`, and the Deno
2.6.8 lane) took 9 minutes on ubuntu-24.04 and 10 minutes on macos-15 in
[run 34995349070](https://github.com/nullstyle/capnpc-wasm/actions/runs/34995349070);
a local cold build is comparable. For quick iteration, run one suite task, or
`mise run --skip-deps test:<suite>` to rerun it without rebuilding.

- C++ port or Wasm feature profile: `mise run test`.
- Rust, Go, or Zig generators: `mise run test`; generated-code consumers
  exercise the pinned runtimes as well as comparing source output.
- TypeScript runtime or bundle: `mise run test`, then `mise run test:browser`
  (after `mise run browser:install` once), and the Deno 2.6.8 worker lane in
  [CONTRIBUTING.md](CONTRIBUTING.md#reproducing-the-ci-lanes)
  (`mise run test:deno-worker` once available).
- Go SDK: `mise exec -- go -C sdk/go test -count=1 -mod=readonly ./...` and
  `mise exec -- go -C sdk/go vet -stdmethods=false ./...`.
- Schema Studio (`examples/browser/`, `scripts/build-studio.ts`,
  `scripts/serve-example.ts`): `mise run test:studio`.
- Release scripts, `bin/capnp-wasm`, or packaged docs: `mise run test:package`
  and `mise run test:launcher`; `mise run test:compiler-host-package` for the
  compiler-host flavor.
- Markdown only: `mise run check:links` and
  `mise exec -- deno fmt --check <files>`; `mise run lint` runs both with every
  other static check.

## Inner loop

Run the narrowest task that covers the change: every `test:<suite>` builds only
what it reads, and `mise run --skip-deps test:<suite>` reruns one without the
build check. Arguments after `--` reach the suite: `--filter <name>` selects a
host or fixture in the Deno suites, `test:sdk-go` takes `-run <name>`, and
`test:zig-unit` fixes its own filters. Warm suites take 1 to 40 s,
`mise run test` about two minutes, `mise run lint` seconds with no build. Then
run the area's gate from Verification by area.

| Change                                     | Fastest check                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `patches/`, `cmake/`, `scripts/build-*.sh` | `test:toolchain` (`-- --filter wasmtime` for one host)                                         |
| `generators/rust`, `generators/go`         | `test:toolchain`, `test:features`                                                              |
| `generators/zig`, Zig fixtures             | `test:zig-unit`, then `test:wire`, `test:reflection`, `test:generator-api`, `test:rpc-codegen` |
| `sdk/typescript/`                          | `test:sdk-ts`, `test:features`; `test:deno-worker` for the worker path                         |
| `sdk/go/`                                  | `test:sdk-go`                                                                                  |
| `scripts/*.ts`, `bin/`, `release.json`     | `lint`, then `test:package`                                                                    |
| `examples/browser/`, Studio scripts        | `build:studio`, then `test:studio`                                                             |
| Markdown, `mise.toml`, workflows           | `lint`, then `ci`                                                                              |

Probes and logs go in `build/scratch/<name>/`; `mise run clean` removes them
with the rest of `build/` and `dist/`, `clean:test` prunes suite work
directories and the Zig test scratch, and `clean:all` also drops `.cache/`. When
other work shares the machine, set `jobs` and the build caps in an ignored
`mise.local.toml`; `MISE_JOBS=1` serializes tasks for a readable log. Commit
each task on its own in the conventional style CONTRIBUTING.md defines, and
finish with `mise run ci` before a rebase or hand-off.

## Release and packaging

- `release.json` holds one version for the three archive flavors: `capnpc-wasm`
  (full SDK), `capnp-wasm-tools` (compiler and Wasmtime launcher), and
  `capnp-wasm-compiler-host` (compiler and TypeScript host).
  `scripts/release.ts` accepts only `X.Y.Z-rc.N` with `private: true`.
- Packaged docs are copied verbatim: `docs/releases.md` becomes each archive's
  `README.md` and `docs/releases.md`; `sdk/typescript/README.md` becomes
  `docs/typescript.md` in the SDK flavors. Editing them changes packaged bytes.
- Published assets are immutable; changed bytes need a new version. Tags are
  `capnp-wasm-tools-v<version>`, `capnp-wasm-compiler-host-v<version>`, and
  `sdk/go/v<version>` for the Go module. Before tagging, add the archive and
  manifest digests to the published releases table in `docs/releases.md` and the
  entry to `CHANGELOG.md`.

## Zig synchronization

- `generators/zig/sync.json` records the native capnp-zig commit, the digest of
  the exported source tree, and the hashes of 36 mirrored fixtures.
  `scripts/build-zig.sh` runs `check:zig-sync` on every build; drift fails it.
- Bump `ref/capnp-zig` with the checklist in `CONTRIBUTING.md`: gitlink,
  `check-zig-sync.ts --record-native`, re-copied fixtures, and the Zig pin in
  `mise.toml` and `mise.lock`.
- `generators/zig/historical-reference` pins the audited revision `08a3e3d` that
  the wire tests use as an oracle; `refs:sync` fetches it. It stays fixed across
  bumps.

## Deno versions

- `mise.toml` pins Deno 2.9.6 for tooling and direct execution.
- Worker execution requires Deno 2.6.8 (`supportedDenoWorkerVersion`).
  `sdk/typescript/sdk_test.ts` ignores worker tests on every other version, so
  `mise run test` on the pinned Deno does not cover worker cancellation. Run the
  CI lane locally with the commands in
  [CONTRIBUTING.md](CONTRIBUTING.md#reproducing-the-ci-lanes)
  (`mise run test:deno-worker` once available).
