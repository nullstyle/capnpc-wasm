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
  [docs/api-stability.md](docs/api-stability.md) for versions, names, and
  stability tiers; [ref/README.md](ref/README.md) for upstream entry points.

## Rules

- Run tools from the repository root through `mise run` or `mise exec --`;
  running mise inside `ref/` activates that upstream's own configuration.
- Keep `ref/` pristine at the recorded gitlinks. Project patches and wrappers
  live outside the submodules and apply to disposable copies under `build/`.
- Tool pins live in `mise.toml`, resolved metadata in `mise.lock`, upstream
  revisions in gitlinks. After changing a pin, run `mise lock <tool>` for that
  tool (a full `mise lock` also re-resolves the conda packages), keep
  `lockfile_version = 1` (CI's mise 2026.9.1 cannot read version 2), and run
  `mise run check`. Native Clang builds native tools; the WASI SDK Clang stays
  off `PATH`.
- Keep the Zig pin equal to `ref/capnp-zig/mise.toml`. `mise.lock` records
  hand-verified sha256 digests with minisign provenance for that development
  build, which only the community mirrors serve: after a Zig bump run
  `mise lock zig`, then `mise run mirror:zig -- lock --write`.
- Preserve the standard binary `CodeGeneratorRequest` boundary with host
  orchestration of generators, WASI Preview 1 command modules (`wasm32-wasip1`),
  standardized Wasm exception handling, and error propagation. Hosts keep
  byte-oriented workspaces, fresh guest instances, read-only inputs, and
  transactional outputs. Cancellation terminates guest execution; a rejected
  promise alone is insufficient.
- Keep the TypeScript SDK's guest rewriter (`sdk/typescript/rewriter.ts`)
  failing closed: every guest is validated and instrumented, a stop is a trap,
  `Worker.terminate()` is only a fallback, and input the rewriter cannot rewrite
  exactly is a `TypeError`. After rewriter changes run `test:browser`, which
  validates the instrumented `dist/wasm` modules with the pinned wasm-tools.
- The two SDKs implement one contract,
  [docs/sdk-contract.md](docs/sdk-contract.md): keep request fields, limits
  (pinned by `tests/fixtures/contract/limits.json`), stage names, and error
  classes aligned, and change the contract document, the export lists in
  `docs/api-stability.md`, and `CHANGELOG.md` with any SDK API change.
- The [schema feature corpus](tests/fixtures/features/README.md) is shared by
  the TypeScript, Go, and browser tests. Read embeds as bytes; compare the
  complete canonical request and every generated source byte with native output
  when adding schema coverage.
- Error paths share the
  [failure and limit conformance corpus](tests/fixtures/conformance/README.md).
  For an error-path change, add a case to `tests/conformance/cases.ts` and its
  outcome to `tests/fixtures/conformance/expected.json`; a surface's departure
  needs a `reason` and a `finding`. Regenerate `cases.json` and `guests.json`
  with the `--write` commands in that README, then run `test:conformance`,
  `test:sdk-go`, `test:launcher`, and `test:browser`.
- Test harnesses under `tests/hosts/` stay separate from the SDKs; the Deno host
  alone imports the SDK's shim facade and ABI corrections
  (`sdk/typescript/shim.ts`, `shim-abi.ts`), so its parity rows run the shipped
  adapter.
- Test guests live as WebAssembly text in `tests/browser/guests/` (hostile) and
  `tests/browser/guests/interrupt/`, embedded as pinned wasm-tools output in
  `sdk/typescript/testdata/hostile_guests.ts` and `interrupt_guests.ts`.
  `test:browser` fails when a pair drifts: after editing a `.wat` file,
  regenerate its hex with the command in the embedding file's header.
- Generated files and build trees go under `build/`, distributable output under
  `dist/`, caches under `.cache/`, ad-hoc probes under `build/scratch/`.
- Shipped Wasm modules meet the contract in `scripts/check-wasm-artifacts.ts`
  (feature allow-list per class, no DWARF or build-host paths, size budget);
  build scripts check every module they link and `check:wasm-artifacts` checks
  `dist/wasm`. Third-party notice texts that no reference or toolchain ships
  live under `third_party/`, pinned to the reference gitlinks.
- Maintain these instructions when a convention changes.

## Verification by area

`mise run check` runs `lint` (static checks with no build, actionlint included),
`doctor`, and `test`: the parity, Zig, SDK, and feature-corpus suites, the
conformance corpus (`test:conformance`), and `test:studio-unit`, one
`test:<suite>` task each, building only what it reads. `test:browser`,
`test:studio`, `test:package`, and `test:launcher` are separate and run only
when named. The CI clean-checkout job took 9 minutes on ubuntu-24.04 and 10
minutes on macos-15 in
[run 34995349070](https://github.com/nullstyle/capnpc-wasm/actions/runs/34995349070);
a local cold build is comparable. For quick iteration, run one suite task, or
`mise run --skip-deps test:<suite>` to rerun it without rebuilding.

`test:browser` runs the engines at once and covers the termination acceptance
and the conformance rows on the direct, worker, and Studio surfaces. Set
`CAPNP_BROWSER_JOBS=1` to run the engines in turn, and
`CAPNP_BROWSER_DEADLINE_MS` or `CAPNP_BROWSER_ENGINE_TIMEOUT_MS` to change the
step or per-engine deadline.

- C++ port, Wasm feature profile, or `scripts/check-wasm-artifacts.ts`:
  `mise run test` (includes `check:wasm-artifacts`).
- Rust, Go, or Zig generators: `mise run test`; generated-code consumers
  exercise the pinned runtimes as well as comparing source output.
- TypeScript runtime or bundle: `mise run test`, then `mise run test:browser`
  (after `mise run browser:install` once).
- Go SDK: `mise run test:sdk-go` and `mise run test:sdk-go-race` (`lint` runs
  the vet).
- Schema Studio (`examples/browser/`, `scripts/build-studio.ts`,
  `scripts/serve-example.ts`): `mise run test:studio-unit` for the pure state
  and workspace modules, then `mise run test:studio`; the driver runs under
  Studio's Content-Security-Policy and fails on any axe-core violation. Keep the
  CSP hash in `examples/browser/index.html` in step with its inline boot script;
  `build:studio` fails otherwise.
- Release scripts, `scripts/templates/`, `bin/capnp-wasm`, or packaged docs:
  `mise run test:package` and `mise run test:launcher`;
  `mise run test:compiler-host-package` for the compiler-host flavor.
- Release evidence (`docs/release-evidence/`, `scripts/check-evidence.ts`,
  `scripts/audit-nightly.ts`): `mise run check:evidence`, part of `lint`,
  validates every receipt against its schema under
  `docs/release-evidence/schemas/`, and `mise run test:evidence` tests both
  scripts; a new receipt type needs a schema, and a hand-audited receipt is
  never rewritten except to add its schema version (`mise run audit:nightly`
  regenerates `nightly-confidence.json`).
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
run the area's gate from Verification by area. The scheduled checks `audit:osv`,
`audit:govulncheck`, `audit:advisories`, and `check:lock-urls`, the soak and
floor tasks `test:browser-soak`, `test:sdk-ts-soak`, and `test:sdk-go-floor`,
the drift signal `test:sdk-go-wazero-latest`, and the canary
`test:termination-canary` need the network and run only when named; the drift
signal and the canary are not gates. `audit:nightly` also needs the network
(read-only `gh`): it rewrites `docs/release-evidence/nightly-confidence.json`,
and `-- --check` only compares.

| Change                                     | Fastest check                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `patches/`, `cmake/`, `scripts/build-*.sh` | `test:toolchain` (`-- --filter wasmtime` for one host)                                         |
| `generators/rust`, `generators/go`         | `test:toolchain`, `test:features`                                                              |
| `generators/zig`, Zig fixtures             | `test:zig-unit`, then `test:wire`, `test:reflection`, `test:generator-api`, `test:rpc-codegen` |
| `sdk/typescript/`                          | `test:sdk-ts` (direct and worker paths), `test:features`, `test:conformance`                   |
| `sdk/go/`                                  | `test:sdk-go`                                                                                  |
| `scripts/*.ts`, `bin/`, `release.json`     | `lint`, then `test:package`                                                                    |
| `examples/browser/`, Studio scripts        | `test:studio-unit`, `build:studio`, then `test:studio`                                         |
| Markdown, `mise.toml`, workflows           | `lint`, then `ci`                                                                              |

Probes and logs go in `build/scratch/<name>/`; `mise run clean` removes them
with the rest of `build/` and `dist/`, `clean:test` prunes suite work
directories and the Zig test scratch, and `clean:all` also drops `.cache/`. When
other work shares the machine, set `jobs` and the build caps in an ignored
`mise.local.toml`; `MISE_JOBS=1` serializes tasks for a readable log. Commit
each task on its own in the conventional style CONTRIBUTING.md defines, and
finish with `mise run ci` before a rebase or hand-off.

## Release and packaging

- `release.json` holds one version per archive flavor under `versions`:
  `capnpc-wasm` (full SDK; its version also names the Go module tag),
  `capnp-wasm-tools` (compiler and Wasmtime launcher), and
  `capnp-wasm-compiler-host` (compiler and TypeScript host).
  `scripts/release.ts` accepts only `X.Y.Z-rc.N` with `private: true` and
  rejects a missing or unknown flavor.
- Each archive's `README.md` is generated from
  `scripts/templates/README-<flavor>.md`. `sdk/typescript/README.md` ships as
  `docs/typescript.md` in the SDK flavors and `sdk/go/README.md` in the full
  SDK, both with relative links rewritten to the repository at the producer
  commit. Editing them or the templates changes packaged bytes;
  `docs/releases.md` is not packaged.
- Published assets are immutable; changed bytes need a new version. Releases are
  built only by `.github/workflows/release.yml` from a pushed tag
  `<flavor>-v<version>` naming that flavor's own version; `sdk/go/v<version>`
  tags the Go module with the `capnpc-wasm` version at the commit of that
  release. Run `git fetch --tags` before preparing a candidate; `release.ts`'s
  tag checks read local tags. Add the `CHANGELOG.md` entry before tagging, the
  archive and manifest digests to the published releases table in
  `docs/releases.md` before publishing the draft, and bump only that flavor's
  entry in `release.json` right after publishing it.

## Zig synchronization

- The `ref/capnp-zig` gitlink is the source of truth. `generators/zig/sync.json`
  only maps the 36 mirrored fixtures to their native paths and records no
  hashes. `mise run check:zig-sync` (part of every `build:zig`) compares the
  prepared sources and the mirrored fixtures with the gitlink; drift fails it.
- Bump `ref/capnp-zig` with the checklist in `CONTRIBUTING.md`: stage the
  gitlink, refresh the mirrors from it and review the diff, then align the Zig
  pin in `mise.toml` and `mise.lock`:

  ```sh
  mise exec -- deno run --allow-read --allow-write=tests --allow-run=git \
    scripts/check-zig-sync.ts --update-fixtures
  ```
- After staging a `ref/capnp-zig` bump and before `mise run test`, run
  `mise run audit:nightly` and commit the regenerated ledger with the bump: the
  bump restarts the nightly streak, and `check:evidence` and `test:evidence`
  fail until the ledger names the new gitlink.
- `generators/zig/historical-reference` pins the audited revision `08a3e3d` that
  the wire tests use as an oracle; `refs:sync` fetches it. It stays fixed across
  bumps.

## Deno versions

- `mise.toml` pins Deno 2.9.6 for tooling and for direct and worker execution.
- Worker execution is admitted on every Deno release, and `mise run test` covers
  worker cancellation on the pinned Deno. `supportedDenoWorkerVersion`
  (`sdk/typescript/environment.ts`) is deprecated: the SDK no longer checks it,
  and it can be removed in `0.2.0`.
- `mise run test:termination-canary` tracks upstream and is not a gate: it
  checks whether `Worker.terminate()` stops a spinning guest on the pinned and
  the newest Deno against the record in `docs/deno-worker-termination.md`. The
  SDK does not rely on `terminate()`.
