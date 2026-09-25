# Release evidence

Machine-readable receipts behind the
[release readiness](../release-readiness.md) gates. Each receipt is a JSON file
in this directory, and its file name selects its type. [`schemas/`](schemas/)
holds one JSON Schema (draft 2020-12) per type. `mise run check:evidence`, part
of `mise run lint`, validates every receipt against its schema, checks that
every receipt a receipt names exists, checks the ledger's counters, dates, and
`ref/capnp-zig` gitlink against its cycles and the index, and fails on a file
that no schema claims or anything else in the directory. It runs offline.
`mise run test:evidence`, part of `mise run test`, runs the streak computation
on synthetic runs and the checker on copies with planted defects.

| Receipt                             | Type                                                                                      | Producer                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `nightly-confidence.json`           | [Nightly-confidence ledger](schemas/nightly-ledger.schema.json)                           | `mise run audit:nightly` (generated)                       |
| `capnp-zig-nightly-confidence.json` | [Superseded capnp-zig ledger](schemas/capnp-zig-ledger.schema.json), frozen on 2026-09-09 | Frozen; superseded by `nightly-confidence.json` (D5 = A)   |
| `nightly-<date>-hosted.json`        | [Scheduled capnp-zig Nightly jobs and steps](schemas/hosted-nightly.schema.json)          | Hand audit                                                 |
| `nightly-<date>-fuzz.json`          | [Scheduled capnp-zig Nightly fuzz audit](schemas/fuzz-nightly.schema.json)                | Hand audit                                                 |
| `<commit>-manual-nightly.json`      | [Manual capnp-zig Nightly fuzz receipts](schemas/manual-nightly.schema.json)              | Hand audit                                                 |
| `<commit>-windows-ci.json`          | [capnp-zig Windows CI jobs](schemas/windows-ci.schema.json)                               | Hand audit                                                 |
| `windows-maker-inheritance.json`    | [capnp-zig Windows Maker experiment](schemas/windows-maker-inheritance.schema.json)       | Hand audit                                                 |
| `initial-hosted-checks.json`        | [Initial hosted acceptance runs](schemas/initial-hosted-checks.schema.json)               | Hand audit                                                 |
| `<commit>-private-package.json`     | [Private package candidate](schemas/private-package.schema.json)                          | Copy of `build/test/package-receipt.json` (`test:package`) |

## Nightly ledger

`mise run audit:nightly` recomputes `nightly-confidence.json` from the GitHub
API with read-only `gh` calls: the streak of successful scheduled runs of
`.github/workflows/nightly.yml` whose head commit pins the `ref/capnp-zig`
revision the index pins. It rewrites the computed fields and keeps the
hand-maintained ones (`requiredConsecutiveScheduledRuns`, `rules`,
`publicationAuthorized`, `supersedes`). `mise run audit:nightly -- --check`
writes nothing and fails when the committed ledger is stale. The nightly
workflow, held on the `quality/held-workflows` branch until it reaches `main`,
runs the task in a `ledger` job after its other jobs and uploads the result as
an artifact; CI never commits it. Commit a regenerated ledger with any
`ref/capnp-zig` bump, since the bump restarts the streak; until then
`check:evidence` fails because the ledger names the previous gitlink. Only a
first-attempt success counts: a run that passed on a re-run ends the streak.

## Versions

Every receipt carries the version its schema requires, in its family's key:
`schemaVersion` in the camelCase receipts, `schema_version` in the snake_case
capnp-zig fuzz receipts. Receipts are evidence: never rewrite a committed one
except to add a missing version. When a producer changes its format, bump the
version it writes and extend the schema so that it accepts both versions (an
`enum` of versions, with the new fields optional), or give the new receipts a
new type. `scripts/check-evidence.ts` implements a subset of JSON Schema and
rejects a schema that uses any other keyword, so an external validator accepts
the same receipts.
