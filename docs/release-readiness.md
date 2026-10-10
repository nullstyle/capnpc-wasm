# Release readiness

Status recorded on 2026-09-22 against `main` at `17c99cb`. This page is the one
place that records where each release gate stands. Update a row when its
evidence changes instead of restating status elsewhere. The
[release guide](releases.md) explains how archives are built, verified, and
published; the [changelog](../CHANGELOG.md) records what shipped; the
[history narrative](history/release-confidence-2026-09.md) keeps the September
2026 evidence trail that this page replaced.

Published: six GitHub prereleases — tools rc.2, compiler-host rc.2 and rc.3
(2026-09-15), the full SDK rc.5 (2026-10-07, the first release built by the
release workflow, with build-provenance and SBOM attestations), and tools rc.3
and the full SDK rc.6 (2026-10-10, the first with the Deno launcher; the full
SDK no longer ships the Zig generator) — listed with their digests under
[published releases](releases.md#published-releases). `release.json` holds one
version per flavor (`capnpc-wasm` 0.1.0-rc.6, `capnp-wasm-tools` 0.1.0-rc.3,
`capnp-wasm-compiler-host` 0.1.0-rc.4) until the two releases are published and
their entries move on, and `scripts/release.ts` refuses to package anything that
is not a private release candidate.

## Gates

| Gate                                                                                                                                                         | Required evidence                                                                                                           | State on 2026-10-07                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Last verified | Automation                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| Clean-checkout `mise run check` (`lint`: shell, formatting, lint, type checks, vet, clippy; `doctor`; `test`: native/Wasm parity, generated consumers, SDKs) | Green on ubuntu-24.04 (x64) and macos-15 (arm64) from a checkout with no build cache                                        | Passing on `f6a9509` ([run 37571913174](https://github.com/nullstyle/capnpc-wasm/actions/runs/37571913174)), with the scheduled and release workflows on `main`                                                                                                                                                                                                                                                                                                                                                                       | 2026-09-15    | `.github/workflows/ci.yml` job `check`, every push and pull request to `main`                   |
| Package gates: `test:package` (full SDK archive, external Deno and Go consumers, the launcher) and the compiler-host package                                 | Green on both CI hosts                                                                                                      | Passing on `f6a9509`: per-push CI and the release workflow's `test:package`/`test:launcher` on the rc.5 build                                                                                                                                                                                                                                                                                                                                                                                                                         | 2026-09-15    | `ci.yml` job `check`                                                                            |
| Worker execution on the pinned Deno: the SDK worker tests, cancellation included (`test:sdk-ts` in `check`), and the compiler-host consumer (`test:package`) | Green on both CI hosts                                                                                                      | Passing on `73d3d6a`, T08's verification branch ([run 36112686931](https://github.com/nullstyle/capnpc-wasm/actions/runs/36112686931)), and on `main` since the merge ([run 37571913174](https://github.com/nullstyle/capnpc-wasm/actions/runs/37571913174))                                                                                                                                                                                                                                                                          | 2026-09-25    | `ci.yml` job `check`                                                                            |
| Browser matrix: offline SDK parity and cancellation in Chromium, Firefox, and WebKit, plus Schema Studio                                                     | Green for all three engines                                                                                                 | Passing on `f6a9509` (Linux, [run 37571913174](https://github.com/nullstyle/capnpc-wasm/actions/runs/37571913174)); on macOS, every job of a manual run of the nightly on the merged tip passed, browsers and soak included ([run 37570711941](https://github.com/nullstyle/capnpc-wasm/actions/runs/37570711941))                                                                                                                                                                                                                    | 2026-09-15    | `ci.yml` job `browsers`                                                                         |
| Checks leave tracked sources unchanged                                                                                                                       | `git diff --exit-code` after the check job                                                                                  | Passing on `f6a9509`. Failed on `a5ccaae`, the compiler-host rc.3 producer commit, on both hosts; fixed by `672679a`                                                                                                                                                                                                                                                                                                                                                                                                                  | 2026-09-15    | `ci.yml` step "Verify checks leave tracked sources unchanged"                                   |
| Nightly confidence: seven consecutive successful scheduled runs of this repository's nightly workflow (decision D5 = A)                                      | The generated [ledger](release-evidence/nightly-confidence.json) (`mise run audit:nightly`) with seven consecutive cycles   | Not met: 0 of 7. The scheduled runs of 2026-10-07 and 10-08 passed; the run of 10-09 failed (a WebKit page crash in the macOS soak and a 906 ms deadline overrun of the `tableFill` step on macos-15-intel), which ended the streak. See [Nightly ledger](#nightly-ledger)                                                                                                                                                                                                                                                            | 2026-10-09    | `scripts/audit-nightly.ts`; job `ledger` of `.github/workflows/nightly.yml`, 11:17 UTC daily    |
| Published asset integrity: archive and manifest SHA-256 recorded in this repository, independent of the download host                                        | A row per published archive in the release guide                                                                            | Recorded for all three archives. The manifest digest of tools rc.2 is not recorded because no byte-identical local copy exists; the digest of its `SHA256SUMS` asset, which lists it, is recorded instead                                                                                                                                                                                                                                                                                                                             | 2026-09-22    | None. `scripts/release.ts` writes `SHA256SUMS`; the table is maintained by hand                 |
| Release signing or attestation                                                                                                                               | Signed `SHA256SUMS` or a provenance attestation, plus verification instructions                                             | `.github/workflows/release.yml`, on `main` since 2026-10-07, attests build provenance for the archive, its manifest, its SPDX SBOM, and `SHA256SUMS`, and the SBOM for the archive; the [release guide](releases.md#release-process) documents `gh attestation verify`. The workflow first ran 2026-10-07 for the full SDK rc.5: the archive and SBOM attestations on the published assets verified with `gh attestation verify`. Immutable releases and tag rulesets are not enabled                                                 | 2026-10-07    | `release.yml`                                                                                   |
| Registry publication path: npm or JSR package and a `sdk/go/v…` module tag                                                                                   | A tag-triggered release job that builds, verifies, and publishes with provenance                                            | A tag-triggered release job (`release.yml`, on `main`; it drafted and published the full SDK rc.5) builds, verifies, and drafts GitHub prereleases with provenance, each flavor at its own `release.json` version; `scripts/release.ts` still accepts only `X.Y.Z-rc.N` with `private: true`. No npm or JSR package is published; decision D2 = A defers registries until after the API freeze and the nightly gate. The Go module tag `sdk/go/v<version>` takes the `capnpc-wasm` version at the commit of that release; none exists | 2026-09-24    | `release.yml` (GitHub prereleases only)                                                         |
| Stable SDK interface                                                                                                                                         | A written contract shared by the TypeScript and Go SDKs, frozen public types, and conformance tests across hosts            | Contract written in [docs/sdk-contract.md](sdk-contract.md); the Go SDK implements it (import roots, limits, typed stages, sentinels, exit codes), limit defaults are pinned in `tests/fixtures/contract/limits.json`, and the failure and limit conformance corpus (`tests/fixtures/conformance`) runs on every surface: `test:sdk-ts`, `test:conformance`, `test:sdk-go`, `test:launcher`, and `test:browser`                                                                                                                       | 2026-09-23    | None                                                                                            |
| Platform coverage beyond per-push CI                                                                                                                         | Results for each host the [support matrix](../README.md#support-matrix) claims                                              | Nightly jobs on `main` since 2026-10-07: Linux arm64 and macOS x64 cold bootstrap, browsers on macOS, and the Go SDK on Windows (passed 10-07 and 10-08; 10-09 failed as above). The Deno launcher on Windows runs per push in the CI job `windows-launcher` (added 2026-10-09, first run pending). Node.js and Bun: direct execution best effort; worker execution admitted on Bun (verified locally on 1.3.14, not in CI) and rejected on Node.js                                                                                   | 2026-10-09    | `nightly.yml`: jobs `bootstrap`, `browsers`, `windows-go-sdk`; `ci.yml`: job `windows-launcher` |
| Explicit publication decision                                                                                                                                | `publicationAuthorized: true` in the ledger and a recorded decision on channels, versioning per flavor, and artifact naming | `false`. Channels, per-flavor versions, and naming are decided (D2 = A: tag-built releases with provenance, registries after the API freeze and the nightly gate; rules in [API stability](api-stability.md)); publication itself is not authorized                                                                                                                                                                                                                                                                                   | 2026-09-24    | Manual                                                                                          |

## 0.1.0 definition of done

`0.1.0` is done when every item below is true and recorded here.

- Artifacts in scope, each with its own version and changelog entry: the
  compiler-only toolchain archive (`capnp-wasm-tools`), the compiler and
  TypeScript host archive (`capnp-wasm-compiler-host`), the full SDK archive
  (`capnpc-wasm`) with all six Wasm commands, and the Go module tag
  `sdk/go/v0.1.0` at the commit of `capnpc-wasm-v0.1.0`. Registry packages (npm,
  JSR) wait for the API freeze and the nightly gate (decision D2 = A).
- API freeze: the TypeScript `CompileRequest`, `GenerationRequest`,
  `CompileError`, and `ResourceLimits` shapes and the Go `Request`,
  `GenerationRequest`, and `Error` shapes are frozen; the stage vocabulary,
  error classes on the direct and worker paths, limit semantics, and generator
  `argv[0]` are identical across hosts and covered by a conformance suite; the
  contract is written down and linked from both SDK READMEs.
- Launcher contract: documented exit codes, `--help` and `--version`, an
  executable `bin/capnp-wasm.ts` in the archive, symlink-safe package-root
  resolution, and either transactional output with a read-only workspace or
  documented native-equivalent semantics; `test:launcher` covers each item.
- Nightly streak: seven consecutive successful scheduled runs of this
  repository's nightly workflow (decision D5 = A), recorded in the generated
  ledger (`mise run audit:nightly`). This repository's nightly runs no fuzz
  jobs. The maintainer settled the open question on 2026-10-07: no fuzz leg in
  this repository's nightly for `0.1.0`.
- Signing: `SHA256SUMS` for every published asset is signed or attested, and the
  release guide tells consumers how to verify it.
- Registry workflow: a tag-triggered CI job builds the archives from a clean
  checkout, runs the package gates, records provenance, and publishes; the
  packaging script gains an explicit, guarded mode for a non-rc, non-private
  version; packaged READMEs are generated per flavor with package-relative paths
  rather than copied from the repository.
- Platform coverage: every host the support matrix lists as supported has a
  recorded test result at the release commit.
- Documentation: the changelog carries the version before the tag is pushed, and
  the published-releases table carries the archive and manifest digests before
  the draft is published.
- An explicit publication decision is recorded in the ledger
  (`publicationAuthorized`) and on this page.

## Nightly ledger

The nightly gate is measured in this repository (decision D5 = A): seven
consecutive successful scheduled runs of `.github/workflows/nightly.yml`. Until
2026-10-09 the gate counted only runs at the `ref/capnp-zig` revision this
repository pinned (last `a37ff29`, tag `v0.24.0`; before that `295ff5e`), and a
bump restarted the count. That day the Zig generator moved to capnp-zig and the
reference was removed, so the ledger (schema version 3) counts runs without a
pin. The workflow runs daily at 11:17 UTC. The held workflows reached `main` on
2026-10-07 (`bbc59ba`), and GitHub schedules a workflow only from the default
branch, so the streak starts with the first scheduled run from `main`, on
2026-10-07. A manual run of the merged tip the same morning
([run 37570711941](https://github.com/nullstyle/capnpc-wasm/actions/runs/37570711941),
`f6a9509`) passed every job: all four cold bootstraps, the browsers and soak
jobs on Linux and macOS, the Go floor and wazero drift, the Windows Go SDK, the
termination canary, the locked download URLs, and the ledger. Runs on
verification branches (push or manual triggers) never count. A push-triggered
verification run of the held workflow
([36095603432](https://github.com/nullstyle/capnpc-wasm/actions/runs/36095603432),
2026-09-25) failed on macOS at the Wasm artifact check, a false positive fixed
in `c74a7aa`, and in the Linux cold bootstrap at a Zig community mirror that
lacks the `.minisig` file. A second verification run, on the throwaway branch
`verify/held-nightly`
([36106633950](https://github.com/nullstyle/capnpc-wasm/actions/runs/36106633950),
2026-09-25: `55e8e2d` from `main` plus the held workflows), passed every job but
one, including the cold bootstrap on ubuntu-24.04, ubuntu-24.04-arm, macos-15,
and macos-15-intel, the Go SDK on Windows, the termination canary, the ledger,
and browsers and soak on Linux. "Browsers and soak (macos-15)" failed at
Firefox's worker abort recovery cycle 5, where the job finished before the abort
took effect: a race in the test, which `16dea94` has since fixed on `main`; with
that fix, the job passed in the verification runs
[36112692524](https://github.com/nullstyle/capnpc-wasm/actions/runs/36112692524)
and
[36120138448](https://github.com/nullstyle/capnpc-wasm/actions/runs/36120138448)
of T08's branch. The Linux cold bootstraps passed in 36106633950 by mirror
choice: mise tried the community mirrors in random order and fetched the
`.minisig` from the one that served the tarball, with no fallback, and
zig.bcr.ist has none (a run of the per-push CI workflow,
[36098649887](https://github.com/nullstyle/capnpc-wasm/actions/runs/36098649887),
failed at that download on attempt 1 and passed on attempt 2 with no change).
`mise.lock` now points at the project's own Zig release,
`toolchain-zig-0.17.0-dev.1683+5ceec001b`: `mise.toml` turns the community
mirrors off and sends mise's Zig requests there, and mise still verifies the
minisign signature and the locked sha256, so every install takes the same files
from one source. Cold local installs on macOS arm64 with mise 2026.9.1 and
2026.9.12 took the tarball and its signature from the release. On 2026-10-09 the
pin moved to the tagged Zig 0.17.0, which ziglang.org keeps, and the mirror
release, its rule, and the `mirror:zig` and `check:zig-lock` tasks were retired.
Later that day the Zig generator moved to capnp-zig, and the Zig toolchain left
this repository with it.

The ledger, [nightly-confidence.json](release-evidence/nightly-confidence.json),
is generated. `mise run audit:nightly` reads the workflow's scheduled runs from
the GitHub API with read-only `gh` calls, then rewrites the counters: `status`,
`currentConsecutiveScheduledRuns`, `firstQualifyingScheduledDateUtc`,
`lastQualifyingScheduledDateUtc`, the qualifying `cycles`, and `streakEnd`, the
run or missed date that ends the streak. `mise run audit:nightly -- --check`
fails when the committed ledger is stale. `mise run check:evidence` validates it
against its [schema](release-evidence/schemas/nightly-ledger.schema.json) and
checks, offline, that its counters and dates match its cycles. The workflow's
`ledger` job runs the audit after the other jobs and uploads the regenerated
ledger as an artifact; CI never commits it. Commit a regenerated ledger to
record progress. The scheduled runs of 2026-10-07 and 2026-10-08 passed at
`295ff5e`. The run of 2026-10-09
([37923718435](https://github.com/nullstyle/capnpc-wasm/actions/runs/37923718435))
failed in two jobs: on macos-15, WebKit's main page crashed in soak round 3
(worker abort recovery cycle 3), and on macos-15-intel, `test:sdk-ts` saw a
direct job's `tableFill` step stop 906 ms past its deadline, beyond the test's
500 ms allowance. The ledger records a streak of 0 of 7, ended by that run.
`publicationAuthorized` remains `false`.

Rules, from the JSON: a cycle is a scheduled run of the workflow. It qualifies
when the run concluded `success` on its first attempt and was never re-run, so
every job without `continue-on-error` succeeded. Manual and local runs never
count. Qualifying cycles fall on consecutive UTC dates, the newest today or
yesterday; a scheduled run that failed or was cancelled ends the streak, and so
does a date without a completed scheduled run. Any re-run ends the streak, even
of a run whose first attempt succeeded, because the API reports only the latest
attempt; do not re-run scheduled nightly runs. A run in progress dated today is
not counted yet; one dated earlier leaves its date without a completed run.
Changes to this repository's sources, reference pins included, do not restart
the count, because per-push CI gates them.

### capnp-zig scheduled Nightly

Before decision D5 the gate counted capnp-zig's own scheduled Nightly
(`nullstyle/capnp-zig`, `.github/workflows/nightly.yml`, 09:17 UTC), which runs
capnp-zig `main`, with every fuzz receipt audited by hand. That ledger is kept
unchanged as
[capnp-zig-nightly-confidence.json](release-evidence/capnp-zig-nightly-confidence.json):
one audited cycle (2026-09-09, native `0fb8df4`), last updated in commit
`b8d8e3f`. capnp-zig's runs do not count toward the gate. Runs observed on
2026-09-24 with
`gh run list --repo nullstyle/capnp-zig --workflow nightly.yml --event schedule`.
Only the 2026-09-09 run has audited receipts
([hosted](release-evidence/nightly-2026-09-09-hosted.json),
[fuzz](release-evidence/nightly-2026-09-09-fuzz.json)); the other rows record
workflow conclusions only.

| Date (UTC) | Run                                                                            | Head      | Conclusion                                   |
| ---------- | ------------------------------------------------------------------------------ | --------- | -------------------------------------------- |
| 2026-09-09 | [34334866428](https://github.com/nullstyle/capnp-zig/actions/runs/34334866428) | `0fb8df4` | success, previous pin, receipts audited      |
| 2026-09-10 | [34460732774](https://github.com/nullstyle/capnp-zig/actions/runs/34460732774) | `0fb8df4` | success, previous pin, receipts unaudited    |
| 2026-09-11 | [34584252852](https://github.com/nullstyle/capnp-zig/actions/runs/34584252852) | `0fb8df4` | success, previous pin, receipts unaudited    |
| 2026-09-12 | [34685741233](https://github.com/nullstyle/capnp-zig/actions/runs/34685741233) | `0fb8df4` | success, previous pin, receipts unaudited    |
| 2026-09-13 | [34750331309](https://github.com/nullstyle/capnp-zig/actions/runs/34750331309) | `0fb8df4` | success, previous pin, receipts unaudited    |
| 2026-09-14 | [34828617106](https://github.com/nullstyle/capnp-zig/actions/runs/34828617106) | `0fb8df4` | success, previous pin, receipts unaudited    |
| 2026-09-15 | [34952938728](https://github.com/nullstyle/capnp-zig/actions/runs/34952938728) | `0c5e33f` | success, never pinned                        |
| 2026-09-16 | [35079521933](https://github.com/nullstyle/capnp-zig/actions/runs/35079521933) | `295ff5e` | success, pinned revision, receipts unaudited |
| 2026-09-17 | [35205304642](https://github.com/nullstyle/capnp-zig/actions/runs/35205304642) | `295ff5e` | success, pinned revision, receipts unaudited |
| 2026-09-18 | [35329598998](https://github.com/nullstyle/capnp-zig/actions/runs/35329598998) | `295ff5e` | success, pinned revision, receipts unaudited |
| 2026-09-19 | [35434607031](https://github.com/nullstyle/capnp-zig/actions/runs/35434607031) | `295ff5e` | success, pinned revision, receipts unaudited |
| 2026-09-20 | [35502221367](https://github.com/nullstyle/capnp-zig/actions/runs/35502221367) | `295ff5e` | success, pinned revision, receipts unaudited |
| 2026-09-21 | [35584000510](https://github.com/nullstyle/capnp-zig/actions/runs/35584000510) | `295ff5e` | success, pinned revision, receipts unaudited |
| 2026-09-22 | [35710421424](https://github.com/nullstyle/capnp-zig/actions/runs/35710421424) | `295ff5e` | success, pinned revision, receipts unaudited |
| 2026-09-23 | [35843089376](https://github.com/nullstyle/capnp-zig/actions/runs/35843089376) | `295ff5e` | success, pinned revision, receipts unaudited |
| 2026-09-24 | [35981446744](https://github.com/nullstyle/capnp-zig/actions/runs/35981446744) | `295ff5e` | success, pinned revision, receipts unaudited |

Reading of the table. `ref/capnp-zig` moved from `0fb8df4` to `295ff5e` on
2026-09-24. capnp-zig's Nightly passed nine consecutive scheduled runs on
`295ff5e` (2026-09-16 through 2026-09-24) with unaudited receipts; `0fb8df4` had
six (2026-09-09 through 2026-09-14) before capnp-zig `main` advanced. Under
decision D5 = A these runs support the choice of revision but do not count: the
gate counts this repository's scheduled runs of `295ff5e`, and none exists yet.
