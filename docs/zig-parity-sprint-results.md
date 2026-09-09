# Zig parity sprint implementation

This is the historical receipt for native revision `86106c2` and its original
downstream synchronization manifest. Later fixes, reference updates, hosted CI,
and package work are tracked in [release readiness](release-readiness.md).
References to the final candidate below mean the end of that earlier sprint.

This sprint implements the approved RPC typing and release-candidate hardening
plan in `capnp-zig` and mirrors the matching runtime/generator into
`capnpc-wasm`. Local acceptance is recorded below. Hosted platform CI and seven
consecutive nightly cycles remain future evidence; this document does not claim
production maturity or a published release.

## Delivered surfaces

- Concrete generic RPC applications, imported and conflicting ancestor brands,
  method-local caller bindings, typed adapters, recursive capability pipelines,
  and exact native/WASI output parity in full and compact profiles.
- Deferred ordered streaming acknowledgements, bounded encoded bytes and call
  counts, readiness/drain callbacks, and ownership across cancellation,
  disconnect, synchronous returns, callback reentrancy, OOM, and reused IDs.
- Bounded registry parsing/lazy defaults and expanded copy work/allocation;
  dynamic Builder queries and explicit borrowed Reader conversion; transactional
  replacement/growth/self-copy and capability-table remapping rollback.
- Independent C++ mutation replay, targeted fuzzing with positive execution
  counts, no-activity/oracle ablations, and source/fixture synchronization
  hashes.

Reflection, generic application views, bounded copy helpers, and deferred
streaming remain Experimental. Existing Stable declarations stay unchanged. Wire
capability indices alone do not transfer capability ownership. Groups copy known
active fields while preserving the destination parent's unrelated data.

## Local acceptance

The pinned Zig version is `0.17.0-dev.1683+5ceec001b`. These results were
obtained locally on macOS arm64; remote platform workflows have not been run on
this candidate.

| Gate                                                                                                            | Result                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Native Debug suite plus reflection WASI/C++, deliberate C++ oracle mismatch, generic RPC C++, and streaming C++ | 226/226 build steps; 1,892 freshly executed tests passed, with other successful steps reused from cache                           |
| Native ReleaseSafe suite plus reflection WASI/C++                                                               | 218/218 steps; 1,985 tests passed and one existing Debug-only thread-affinity observation skipped                                 |
| Stable/Experimental API checks, closure, docs smoke/snippets, clean-package consumer                            | 24/24 steps; 19/19 tests passed; all 1,573 Stable declarations unchanged                                                          |
| QUIC API and closure checks                                                                                     | Passed with strict Experimental snapshot                                                                                          |
| Regenerated bindings                                                                                            | `just check-generated` passed                                                                                                     |
| Existing C++/Go/Rust/Python RPC matrix                                                                          | 40 passed, zero failed, eight existing documented L3/L4 skips                                                                     |
| Downstream `mise run check`                                                                                     | Passed compiler/generator host parity, wire/reflection tests, native/WASI generic and RPC consumers, and TypeScript/Go SDK checks |

Generic RPC consumers exercise ten cases in each full/compact profile, natively
and under WASI. Real C++ interoperability adds ten directional scenarios per
profile, including capability invocation before the parent result arrives.
Streaming consumers cover fifteen cases per profile, including deferred
acknowledgement, pressure recovery, cancellation, reused IDs, and nested
transport-close callbacks; independent C++ endpoints run in both directions.

The negative controls require an injected C++ oracle mismatch to exit with code
2 and reject a real successful child process that reports no fuzz activity.
Source/fixture drift controls reject changed, missing, and extra prepared files,
changed fixtures, and ignored files absent from the native commit. Failed record
attempts preserve the previous manifest. Restoring the inputs returns the check
to green.

The performance matrix and raw measurement summary are committed in native
`docs/parity-sprint-performance.md` and `docs/parity-sprint-performance.json`.
They compare baseline `68ad72f` with the candidate on the same host/toolchain:
16 generation configurations and 60 runtime rows. Source and benchmark digests
were unchanged during measurement. Concurrent integration work affects wall
timings; CPU measurements and exact allocation/size counts inform the tradeoffs.

Large-schema generated source grows by 426,929 bytes (15.3–21.6%, depending on
profile/reflection) from the added generic application APIs. Consumer binaries
grow by only 448–464 bytes with reflection enabled and remain unchanged without
reflection. Dynamic reads stay within baseline noise; large dynamic copies use
the same three allocations and 198,616 bytes, but take 50.3% more CPU for the
bounded preflight. Earlier avoidable copy allocations and read overhead were
removed. The remaining preflight is retained to enforce limits before mutation;
this is a documented cost of the new bounded operation.

The implementation was committed in native
`86106c226f197d26f280442598155898e7fb1fb1`. That sprint's sync manifest verified
194 sources and 35 mirrored fixtures against committed Git objects, with source
digest `d7338312877832c5f3610a618fe9671588eeb512ada870881ad041b13f6dc514`. Every
Zig build enforces this check; `mise run check:zig-sync` also verifies an
existing prepared tree without the native checkout. References and gitlinks
remain unchanged.

The final fuzz campaign on clean native revision `86106c2` passed all 16 targets
with at least 10,000 measured new executions each, using seed `0x6ca9b3d1`.
Reflection registry loading executed 11,609 cases, dynamic mutation 10,027, and
generated streaming lifecycle/ordered barriers 10,078. The durable manifest,
per-target arguments, source hashes, execution counts, and durations are in
native `docs/parity-sprint-fuzz.json`; complete logs and corpus remain under
`.zig-cache/fuzz-evidence/run-1788919344839469000`, `.zig-cache/f`, and
`.zig-cache/v`. The clean final campaign follows the documented development
failures and corrective runs; it does not turn those earlier failures into
passes.

The final downstream `mise run check` passed with synchronization enforced by
the build. Local gate logs are retained under downstream `build/zig-sprint-*`
and native `.zig-cache/parity-sprint/`. No source changes followed these final
measurements and checks.

## Remaining maturity evidence

The configured Linux/macOS/Windows workflows must run against the committed
candidate before platform acceptance. Require seven consecutive clean nightly
fuzz/soak cycles with positive activity and exercise a real downstream service
through cancellation, reconnection, schema evolution, and shutdown before a
broader maturity claim.

This sprint does not add a JSON codec, dynamic RPC dispatcher, orphan/adopt API,
adaptive flow control, new transports, production vat addressing/authentication,
or additional L4 interoperability. Existing reference-runtime skips retain their
reasons. Remote push, release tags, and publication await explicit direction.
