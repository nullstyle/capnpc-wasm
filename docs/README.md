# Documentation index

Current documents describe the repository as it is today and are kept up to
date. History keeps dated records that are no longer maintained; read them for
provenance, not for guidance.

## Current

| Document                                              | Use it for                                                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [Architecture](architecture.md)                       | The data flow from schemas through the compiler and generators to the hosts, and which directory owns what |
| [Threat model](threat-model.md)                       | Trust boundaries per host, which inputs are untrusted, known gaps, and guidance for consumers              |
| [Releases](releases.md)                               | Published archives and their digests, candidate preparation and verification, launcher and package details |
| [Release readiness](release-readiness.md)             | The gate table, the 0.1.0 definition of done, and the nightly ledger                                       |
| [Deno worker termination](deno-worker-termination.md) | The evidence behind the Deno 2.6.8 worker requirement                                                      |
| [Release evidence](release-evidence/)                 | Machine-readable receipts referenced by the readiness page and the history narrative                       |

Root documents: [README](../README.md) for the consumer quick start, support
matrix, generated-code runtime requirements, and layout;
[CONTRIBUTING](../CONTRIBUTING.md); [SECURITY](../SECURITY.md);
[CHANGELOG](../CHANGELOG.md); [AGENTS](../AGENTS.md) for agent conventions.

Area guides live beside their code:
[patches/capnproto](../patches/capnproto/README.md),
[patches/capnp-zig](../patches/capnp-zig/README.md),
[generators](../generators/README.md),
[generators/zig](../generators/zig/README.md),
[sdk/typescript](../sdk/typescript/README.md), [sdk/go](../sdk/go/README.md),
[examples/browser](../examples/browser/README.md),
[tests/browser](../tests/browser/README.md),
[tests/fixtures/features](../tests/fixtures/features/README.md),
[tests/reflection](../tests/reflection/README.md),
[tests/wire](../tests/wire/README.md),
[tests/generator_api](../tests/generator_api/README.md),
[tests/rpc_codegen](../tests/rpc_codegen/README.md),
[tests/hosts/deno](../tests/hosts/deno/README.md),
[tests/hosts/wazero](../tests/hosts/wazero/README.md), and
[ref](../ref/README.md).

## History

| Document                                                                  | Frozen     | What it records                                                                                                        |
| ------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| [capnp-zig compatibility audit](history/capnp-zig-compatibility-audit.md) | 2026-09-08 | Findings against capnp-zig `08a3e3d` and the patch-era remediation; code citations are permalinks at audited revisions |
| [Zig parity sprint plan](history/zig-parity-sprint-plan.md)               | 2026-09-08 | The acceptance plan for the RPC typing and hardening sprint (baselines capnp-zig `68ad72f`, capnpc-wasm `a2a18ec`)     |
| [Zig parity sprint results](history/zig-parity-sprint-results.md)         | 2026-09-08 | The local acceptance receipt for native capnp-zig `86106c2`                                                            |
| [Release confidence narrative](history/release-confidence-2026-09.md)     | 2026-09-09 | The hosted CI, Windows, package, and nightly evidence trail through commit `b8d8e3f`                                   |

Every Markdown file outside `ref/` is link-checked by `mise run check:links`
(relative links and heading anchors). `mise run lint` also runs
`deno fmt --check` over the paths in `mise.toml`'s `fmt_paths`, which cover
`docs/` and the area READMEs but not yet the root `SECURITY.md`,
`CONTRIBUTING.md`, and `CHANGELOG.md`; format those by hand.
