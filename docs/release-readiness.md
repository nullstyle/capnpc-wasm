# Release readiness

Status recorded on 2026-09-22 against `main` at `17c99cb`. This page is the one
place that records where each release gate stands. Update a row when its
evidence changes instead of restating status elsewhere. The
[release guide](releases.md) explains how archives are built, verified, and
published; the [changelog](../CHANGELOG.md) records what shipped; the
[history narrative](history/release-confidence-2026-09.md) keeps the September
2026 evidence trail that this page replaced.

Published today: three GitHub prereleases, all dated 2026-09-15, listed with
their digests under [published releases](releases.md#published-releases). The
full SDK archive (`capnpc-wasm`) has never been published. `release.json` holds
one version, `0.1.0-rc.3`, for all three archive flavors, and
`scripts/release.ts` refuses to package anything that is not a private release
candidate.

## Gates

| Gate                                                                                                                                                                    | Required evidence                                                                                                           | State on 2026-09-22                                                                                                                                                                                                                                                       | Last verified | Automation                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------- |
| Clean-checkout `mise run check` (`lint`: shell, formatting, lint, type checks, vet, clippy, `zig fmt`; `doctor`; `test`: native/Wasm parity, generated consumers, SDKs) | Green on ubuntu-24.04 (x64) and macos-15 (arm64) from a checkout with no build cache                                        | Passing on `17c99cb` ([run 34995349070](https://github.com/nullstyle/capnpc-wasm/actions/runs/34995349070))                                                                                                                                                               | 2026-09-15    | `.github/workflows/ci.yml` job `check`, every push and pull request to `main`                         |
| Package gates: `test:package` (full SDK archive, external Deno and Go consumers, both launchers) and the compiler-host package                                          | Green on both CI hosts                                                                                                      | Passing on `17c99cb`                                                                                                                                                                                                                                                      | 2026-09-15    | `ci.yml` job `check`                                                                                  |
| Supported Deno worker lane: SDK tests with worker tests enabled and the compiler-host consumer, both on Deno 2.6.8                                                      | Green on both CI hosts                                                                                                      | Passing on `17c99cb`                                                                                                                                                                                                                                                      | 2026-09-15    | `ci.yml` step "Verify supported Deno worker execution and termination"                                |
| Browser matrix: offline SDK parity and cancellation in Chromium, Firefox, and WebKit, plus Schema Studio                                                                | Green for all three engines                                                                                                 | Passing on `17c99cb` (Linux only)                                                                                                                                                                                                                                         | 2026-09-15    | `ci.yml` job `browsers`                                                                               |
| Checks leave tracked sources unchanged                                                                                                                                  | `git diff --exit-code` after the check job                                                                                  | Passing on `17c99cb`. Failed on `a5ccaae`, the compiler-host rc.3 producer commit, on both hosts; fixed by `672679a`                                                                                                                                                      | 2026-09-15    | `ci.yml` step "Verify checks leave tracked sources unchanged"                                         |
| Zig source synchronization: the prepared source tree and 36 mirrored fixtures match the `ref/capnp-zig` gitlink (`mise run check:zig-sync`)                             | `check:zig-sync` passes for native commit `0fb8df4`                                                                         | Passing; it runs inside every `build:zig`                                                                                                                                                                                                                                 | 2026-09-15    | `scripts/check-zig-sync.ts`, invoked by `scripts/build-zig.sh`                                        |
| Nightly confidence: seven consecutive scheduled capnp-zig Nightly successes on the pinned native revision, receipts audited                                             | Ledger with one audited entry per cycle                                                                                     | Not met on the pinned revision. Six consecutive scheduled successes on `0fb8df4` (2026-09-09 to 2026-09-14), then capnp-zig `main` moved. See [Nightly ledger](#nightly-ledger)                                                                                           | 2026-09-22    | None in this repository. `nullstyle/capnp-zig` `.github/workflows/nightly.yml`, cron `17 9 * * *` UTC |
| Published asset integrity: archive and manifest SHA-256 recorded in this repository, independent of the download host                                                   | A row per published archive in the release guide                                                                            | Recorded for all three archives. The manifest digest of tools rc.2 is not recorded because no byte-identical local copy exists; the digest of its `SHA256SUMS` asset, which lists it, is recorded instead                                                                 | 2026-09-22    | None. `scripts/release.ts` writes `SHA256SUMS`; the table is maintained by hand                       |
| Release signing or attestation                                                                                                                                          | Signed `SHA256SUMS` or a provenance attestation, plus verification instructions                                             | Not started. `manifest.json` detects tampering but is not a signature                                                                                                                                                                                                     | 2026-09-22    | None                                                                                                  |
| Registry publication path: npm or JSR package and a `sdk/go/v…` module tag                                                                                              | A tag-triggered release job that builds, verifies, and publishes with provenance                                            | Not started. `scripts/release.ts` accepts only `X.Y.Z-rc.N` with `private: true`; no `sdk/go/v*` tag exists; CI has no release job                                                                                                                                        | 2026-09-22    | None                                                                                                  |
| Stable SDK interface                                                                                                                                                    | A written contract shared by the TypeScript and Go SDKs, frozen public types, and conformance tests across hosts            | Contract written in [docs/sdk-contract.md](sdk-contract.md); the Go SDK implements it (import roots, limits, typed stages, sentinels, exit codes), limit defaults are pinned in `tests/fixtures/contract/limits.json`, and cross-host conformance tests are pending (T13) | 2026-09-23    | None                                                                                                  |
| Platform coverage beyond per-push CI                                                                                                                                    | Results for each host the [support matrix](../README.md#support-matrix) claims                                              | Untested: linux-arm64, macOS x64, Windows, browsers on macOS, Node, and Bun                                                                                                                                                                                               | 2026-09-22    | None                                                                                                  |
| Explicit publication decision                                                                                                                                           | `publicationAuthorized: true` in the ledger and a recorded decision on channels, versioning per flavor, and artifact naming | `false`. The decision is open (quality-plan decision D2, tracked outside this repository)                                                                                                                                                                                 | 2026-09-09    | Manual                                                                                                |

## 0.1.0 definition of done

`0.1.0` is done when every item below is true and recorded here.

- Artifacts in scope, each with its own version and changelog entry: the
  compiler-only toolchain archive (`capnp-wasm-tools`), the compiler and
  TypeScript host archive (`capnp-wasm-compiler-host`), the full SDK archive
  (`capnpc-wasm`) with all six Wasm commands, and the Go module tag
  `sdk/go/v0.1.0`. Whether registries (npm, JSR) are in scope is part of
  decision D2.
- API freeze: the TypeScript `CompileRequest`, `GenerationRequest`,
  `CompileError`, and `ResourceLimits` shapes and the Go `Request`,
  `GenerationRequest`, and `Error` shapes are frozen; the stage vocabulary,
  error classes on the direct and worker paths, limit semantics, and generator
  `argv[0]` are identical across hosts and covered by a conformance suite; the
  contract is written down and linked from both SDK READMEs.
- Launcher contract: documented exit codes, `--help` and `--version`, an
  executable `bin/capnp-wasm` in the archive, symlink-safe package-root
  resolution, and either transactional output with a read-only workspace or
  documented native-equivalent semantics; `test:launcher` covers each item.
- Nightly streak: seven consecutive scheduled Nightly successes measured on the
  native revision this repository pins, with per-target fuzz receipts audited
  and the ledger updated for each cycle. How the streak is measured (a scheduled
  workflow here against the gitlink, or capnp-zig `main` with a matching
  reference bump) is decision D5.
- Signing: `SHA256SUMS` for every published asset is signed or attested, and the
  release guide tells consumers how to verify it.
- Registry workflow: a tag-triggered CI job builds the archives from a clean
  checkout, runs the package gates, records provenance, and publishes; the
  packaging script gains an explicit, guarded mode for a non-rc, non-private
  version; packaged READMEs are generated per flavor with package-relative paths
  rather than copied from the repository.
- Platform coverage: every host the support matrix lists as supported has a
  recorded test result at the release commit.
- Documentation: the published-releases table and the changelog carry the new
  digests and versions before the tag is pushed.
- An explicit publication decision is recorded in the ledger
  (`publicationAuthorized`) and on this page.

## Nightly ledger

The nightly gate is measured in a different repository. The machine-readable
ledger is [nightly-confidence.json](release-evidence/nightly-confidence.json).
It records the workflow (`nullstyle/capnp-zig`, `.github/workflows/nightly.yml`,
`schedule` event, 09:17 UTC), the pinned native revision
`0fb8df40126ea166f95016963c465b03db22819e` (the `ref/capnp-zig` gitlink), the
accepted Wasm revision `94ba6b2`, the rules, and one audited cycle. Its last
audited scheduled date is 2026-09-09 and its consecutive count is 1; it has not
been updated since commit `b8d8e3f`. This repository has no scheduled workflow
of its own, and the daily follow-up the ledger names (05:00 America/Anchorage)
is a manual step that was last performed on 2026-09-09.

Ledger rules, copied from the JSON: every job must succeed; execution receipts
for every discovered fuzz target are audited against the exact source revision
and the 10,000-iteration floor; manual and local runs never count; a missed or
failed scheduled run breaks the streak; relevant runtime, generator, test,
dependency, or gate changes reset the evidence; evidence-only documentation
updates do not.

Scheduled Nightly runs observed on 2026-09-22 with
`gh run list --repo nullstyle/capnp-zig --workflow nightly.yml`. Only the
2026-09-09 run has audited receipts
([hosted](release-evidence/nightly-2026-09-09-hosted.json),
[fuzz](release-evidence/nightly-2026-09-09-fuzz.json)); the later rows record
workflow conclusions only.

| Date (UTC) | Run                                                                            | Head      | Conclusion                   |
| ---------- | ------------------------------------------------------------------------------ | --------- | ---------------------------- |
| 2026-09-09 | [34334866428](https://github.com/nullstyle/capnp-zig/actions/runs/34334866428) | `0fb8df4` | success, receipts audited    |
| 2026-09-10 | [34460732774](https://github.com/nullstyle/capnp-zig/actions/runs/34460732774) | `0fb8df4` | success, receipts unaudited  |
| 2026-09-11 | [34584252852](https://github.com/nullstyle/capnp-zig/actions/runs/34584252852) | `0fb8df4` | success, receipts unaudited  |
| 2026-09-12 | [34685741233](https://github.com/nullstyle/capnp-zig/actions/runs/34685741233) | `0fb8df4` | success, receipts unaudited  |
| 2026-09-13 | [34750331309](https://github.com/nullstyle/capnp-zig/actions/runs/34750331309) | `0fb8df4` | success, receipts unaudited  |
| 2026-09-14 | [34828617106](https://github.com/nullstyle/capnp-zig/actions/runs/34828617106) | `0fb8df4` | success, receipts unaudited  |
| 2026-09-15 | [34952938728](https://github.com/nullstyle/capnp-zig/actions/runs/34952938728) | `0c5e33f` | success, not the pinned head |
| 2026-09-16 | [35079521933](https://github.com/nullstyle/capnp-zig/actions/runs/35079521933) | `295ff5e` | success, not the pinned head |
| 2026-09-17 | [35205304642](https://github.com/nullstyle/capnp-zig/actions/runs/35205304642) | `295ff5e` | success, not the pinned head |
| 2026-09-18 | [35329598998](https://github.com/nullstyle/capnp-zig/actions/runs/35329598998) | `295ff5e` | success, not the pinned head |
| 2026-09-19 | [35434607031](https://github.com/nullstyle/capnp-zig/actions/runs/35434607031) | `295ff5e` | success, not the pinned head |
| 2026-09-20 | [35502221367](https://github.com/nullstyle/capnp-zig/actions/runs/35502221367) | `295ff5e` | success, not the pinned head |
| 2026-09-21 | [35584000510](https://github.com/nullstyle/capnp-zig/actions/runs/35584000510) | `295ff5e` | success, not the pinned head |
| 2026-09-22 | [35710421424](https://github.com/nullstyle/capnp-zig/actions/runs/35710421424) | `295ff5e` | success, not the pinned head |

Reading of the table. The pinned revision `0fb8df4` accumulated six consecutive
scheduled successes (2026-09-09 through 2026-09-14). On 2026-09-15 capnp-zig
`main` advanced by three commits (`c30abbb`, `0c5e33f`, `295ff5e`; `0c5e33f` is
a code-generation fix), and Nightly runs on `main`, so the pinned revision can
no longer accrue scheduled cycles. `295ff5e` has seven consecutive scheduled
successes (2026-09-16 through 2026-09-22) with unaudited receipts, but it is not
the revision this repository builds or tests. Under the ledger's own rules the
gate is therefore not met for `0fb8df4`, and the streak on `main` counts only if
decision D5 changes what is measured and `ref/capnp-zig` is bumped to a revision
that the streak covers. `publicationAuthorized` remains `false`.
