# Zig parity sprint: RPC typing and release-candidate hardening

> Historical document. This plan was written before the sprint and marked
> implemented on 2026-09-08. It was moved here and renamed from
> `zig-parity-next-sprint.md` on 2026-09-22. The "likely native files" it names
> are files in the capnp-zig repository. Current Zig behavior is documented in
> the [Zig generator guide](../../generators/zig/README.md).

Status: implemented with local acceptance completed, 2026-09-08. This document
retains the acceptance plan;
[implementation results](zig-parity-sprint-results.md) record the delivered
work, verification, and remaining hosted/production evidence.

Baselines: native `capnp-zig` at `68ad72f`; `capnpc-wasm` at `a2a18ec`. Both
working trees were clean when planning began. All 188 native source files
matched the prepared Wasm tree at the preceding handoff.

## Outcome

Make the supported serialization, generated data/reflection, and ordinary
two-party RPC surfaces credible release-candidate choices alongside the pinned
C++, Rust, and Go implementations. Close the remaining RPC typing gaps and
exercise failure paths in the recently added interfaces before expanding scope.

Feature parity is a per-feature comparison, not the union of every feature in
every language. C++'s dynamic data model is the reflection reference; C++ and
Rust are the concrete-generic references; C++/Go/Rust provide independent wire
and RPC consumers. The upstream
[language implementation overview](https://capnproto.org/otherlang.html) also
distinguishes implementation readiness rather than promising a uniform feature
set. The
[C++ reflection documentation](https://capnproto.org/cxx.html#dynamic-reflection)
describes runtime schema inspection and dynamic data access, which Zig now has.

Passing this sprint establishes a tested release candidate for that scope.
Production maturity additionally needs repeated clean platform runs and use in
real consumers; it cannot be inferred from a larger passing unit-test count.

## 1. Close ownership and failure-path risks first

These are source-indicated risks to reproduce, not newly confirmed runtime bugs.
Write failing public-interface regressions before changing the implementation.

| Work                                        | Current evidence                                                                                                                                                                       | Acceptance                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generated streaming call lifetime           | `interface_gen.zig` allocates a `StreamCallContext` and uses legacy `sendCall`; ordinary generated calls use settlement tracking and a question destructor.                            | Pending peer teardown, disconnect, cancellation, synchronous Return followed by send error, callback reentrancy, and every allocation failure destroy each context once and settle counters once. No leaks, double frees, or underflow.                                                                    |
| Dynamic struct/group replacement and growth | `reflection/dynamic.zig` publishes replacement struct pointers before copying finishes; group initialization can clear storage before copying; list expansion has rollback protection. | Replacing, growing, and copying structs/groups preserves the original reachable value and union state on failure, including unknown fields. Cover self-copy, overlapping views, and allocation-failure sweeps through public dynamic operations. Temporary unreachable builder allocations remain allowed. |
| Capability-bearing copies                   | Wire cloning preserves numeric capability-table indices; it does not transfer RPC capability ownership.                                                                                | Document the wire-copy contract. Provide or reuse an explicit RPC-aware copy/remap seam for copies between distinct tables, then prove the copied capability invokes the original server and references drain after success/failure. Ordinary wire copying must not claim cross-table ownership transfer.  |

Reuse the ordinary generated-call ownership mechanism and
`serialization/generated_helpers.zig` copy machinery where their contracts fit.
Keep state transitions and rollback inside those modules rather than repeating
them in generated methods or dynamic setters.

Likely native files: `src/capnpc-zig/interface_gen.zig`,
`src/reflection/dynamic.zig`, `src/serialization/generated_helpers.zig`,
`src/serialization/message/`, and the existing RPC capability-table/peer
modules.

## 2. Finish typed RPC applications

Extend the shared generic resolver/application model instead of writing a second
specialization engine for RPC. Preserve existing erased interfaces and Stable
declarations; add concrete views where the schema or caller establishes the
binding.

- Parameterized interfaces: typed parameters, results, clients, server adapters,
  and callbacks for applications such as `Service(Text)` and `Service(Data)`.
- Inheritance: carry superclass brands through ancestor collection. Cover
  imported `Parent(Text)`, diamonds with equivalent bindings, and conflicting
  bindings. Match the reference compiler's accepted/rejected behavior.
- Pipelines: follow a capability bound through a parameter, such as
  `Box(Service).value :T`. Key recursion and reuse by node plus resolved binding
  environment so different applications never share the wrong wrapper.
- Method-local generics: explicit caller-side instantiation supplies typed
  request/result/pipeline views. Keep server dispatch erased where the wire
  carries no type binding; do not invent protocol type tags. The pinned C++
  generator also distinguishes typed client requests from generic server
  handlers.

Acceptance: compile and run actual compiler-produced schemas in full and compact
profiles, with two different bindings in one program, imported inheritance,
recursive data, and capability invocation before the parent result arrives.
Native and WASI generator output must match exactly. Run the same consumer
natively and under WASI, and add real C++↔Zig calls in both directions. Assert
declaring interface IDs, method ordinals, and capability lifetime cleanup.

Likely native files: `src/capnpc-zig/generic_application.zig`,
`brand_fidelity.zig`, `generator.zig`, `interface_gen.zig`, and
`src/serialization/type_resolver.zig`. Extend the existing generic/RPC fixtures
and the downstream `tests/generator_api_test.ts` / `tests/rpc_codegen_test.ts`.

## 3. Make streaming asynchronous and bounded

After workstream 1's ownership regressions pass:

- Add generated deferred streaming handlers using the existing deferred-return
  lifetime model, with acknowledgement after application work completes.
- Serialize delivery for a stream and preserve subsequent call/barrier order.
- Bound both outstanding calls and encoded bytes. Measure/reserve before
  committing a send, specify the oversized-call policy, and restore capacity on
  every terminal path. Account for queued input as well as outbound calls.
- Expose readiness and drain notification; a slow receiver must apply pressure
  without busy waiting. Propagate terminal stream failure consistently.

Acceptance: C++↔Zig slow-consumer tests show bounded byte/call counters, ordered
delivery, delayed acknowledgement, readiness recovery, and a final barrier that
cannot overtake pending work. Add cancellation, close, failure, and OOM cases;
all contexts, capability references, and reservations must drain. Preserve the
order of already-committed protocol messages.

Start with a fixed configurable byte window. Adaptive congestion tuning is
outside this sprint. The local references are
`ref/capnproto/c++/src/capnp/stream.capnp` and `rpc.h` (`RpcFlowController`);
the native implementation seam is `src/rpc/transport/stream_state.zig` plus
generated dispatch in `interface_gen.zig`.

## 4. Bound reflection work and make conformance durable

The native repository already has platform CI, API checks, packaging gates, soak
tests, and fuzzing. Extend those gates for the new surfaces.

**Bounded schema loading.** Add explicit reflection load options for input size,
parser allocation budget, and structural work limits. Reject oversized input
before duplicating it; enforce memory limits during parsing and lazy default
materialization rather than merely checking node counts afterward. Preserve the
current convenience entry point with documented defaults. Test malformed
descriptors, huge collections, shared/cyclic defaults, repeated lookup, and OOM.
Retain the documented synchronization requirement for the lazy default cache;
thread-safe sharing is not implied by read-shaped method names.

**Bounded copying.** Add Experimental copy options for visited work and output
allocation; the existing depth limit alone does not bound wide or shared-pointer
amplification. Reuse those limits for dynamic operations and RPC-aware copies
without changing frozen low-level signatures. Test each limit immediately below,
at, and above its threshold, including wasm32 arithmetic and allocation failure.

**Dynamic Builder queries.** Add scalar reads, presence/union queries, and a
reader conversion using the same explicit-storage lifetime model as generated
Builders. Reuse existing defaults and union checks. Compile/run examples must
show rebinding after mutation and reacquiring elements after list growth.

**Independent mutation checks.** Extend the structured corpus from near/far wire
equivalence into generated and dynamic reads, writes, copying, defaults, union
selection, and schema evolution. Compare logical values and preserved unknown
fields with a pinned C++ dynamic consumer. Compare canonical bytes only where
encoding equivalence is promised. Classify invalid-input outcomes explicitly;
matching C++ crashes is never acceptance, and Zig UTF-8 strictness must not be
mistaken for a wire mismatch.

**CI evidence.** Make `test-reflection-cpp` and `test-reflection-wasi` mandatory
in a suitably provisioned native Linux job; they are currently optional gates
absent from native workflows. Keep native tests on all three existing OS lanes.
Retain downstream `mise run check` for actual native/Wasm generation and use.

**Fuzz evidence.** Add targeted reflection mutation and generated RPC lifecycle
targets to the existing fuzz system. Keep deterministic seeds in ordinary CI;
nightly runs must record per-target execution counts, duration, seed/corpus, and
tool revisions. The current timeout-based success branch can include compilation
time, so elapsed wall time alone is insufficient evidence. Enforce an observed
per-target activity floor and fail when no target executes. Persist and minimize
every failure into a replayable regression. Deliberately inject an oracle
mismatch and a no-activity run to prove that the new gates fail when their
evidence is absent or contradictory.

**Reproducible synchronization.** Record the native commit and source-tree
digest in downstream sync metadata and add a repeatable source/fixture check.
Downstream verification must work without an absolute path to a developer's
native checkout. Continue applying patches to disposable source copies; keep all
references pristine and gitlinks unchanged unless deliberately updated.

**Performance receipts.** Before declaring the candidate ready, record cold/warm
generation and consumer compilation time, generated source and binary size,
registry load allocation/latency, and typed/dynamic read/copy costs for small
and large pinned schemas. Include reflection enabled/disabled and full/compact
profiles. Compare to the sprint baseline on the same toolchain and host;
investigate material regressions before setting durable measured thresholds.

Likely files: `src/reflection/registry.zig`, native `tests/reflection/`,
`tests/fuzz/fuzz_targets.zig`, `build/reflection.zig`, `.github/workflows/`, and
downstream `scripts/build-zig.sh`, `patches/capnp-zig/`, and conformance
fixtures.

## Execution and merge order

1. Freeze the feature/acceptance matrix and add the ownership reproductions.
2. Run three bounded lanes: ownership + streaming; generic RPC; reflection
   limits + differential conformance. Ownership and generics both touch
   `interface_gen.zig`, so give that file one owner and sequence integration.
3. Land native changes in reviewable increments, regenerate bindings/snapshots,
   and synchronize each accepted increment into the downstream patch pipeline.
4. Complete CI wiring, performance receipts, and the release-candidate check.

A discovered lifetime, data-loss, or bounded-resource defect takes priority over
more typed conveniences. Do not cut conformance or failure-path coverage to fit
the feature work; split the remaining feature work explicitly if necessary.

## Sprint exit criteria

- Every mandatory case above passes through public generated/dynamic interfaces.
  Source-indicated risks have a reproduction result and a regression or a
  documented reason they do not occur.
- Native Debug and ReleaseSafe suites, Stable API/closure checks, generated-file
  checks, documentation and clean-package consumers pass.
- Native/WASI source equality and execution pass; independent C++ descriptor,
  message-mutation, generic RPC, and streaming cases pass.
- Existing C++/Go/Rust RPC cases remain green. Keep enumerated reference-runtime
  skips with reasons; no new unexplained skip or reduced assertion count.
- The configured platform CI runs on the candidate revision before claiming
  platform acceptance. Local macOS results alone do not establish this.
- Fuzz runs have actual per-target activity and replayable artifacts;
  performance measurements are recorded and regressions resolved or explicitly
  accepted.
- Docs distinguish wire-copy ownership, borrowed-reader lifetimes, reflection
  limits, generic bindings, streaming pressure, and remaining Experimental work.
- Both repositories contain matching committed sources; references stay
  pristine. Remote pushes, publication, and release tags follow explicit user
  direction.

For a subsequent maturity claim, require at least seven consecutive clean
nightly cycles with positive fuzz/soak activity and validate at least one real
downstream service through cancellation, reconnection, schema evolution, and
shutdown. This is a minimum release-confidence gate, not proof of years of
production reliability. Keep reflection Experimental until its interface and
ownership review is complete; passing tests alone does not promote it.

## Explicit deferrals

No generic JSON codec, dynamic RPC dispatcher, orphan/adopt model, production
vat addressing/authentication policy, adaptive stream controller, new transport,
or L4 interoperability expansion. L3 retained-answer/redirected-result C++ cases
are follow-on work after this candidate. Go/Rust/C++ have different higher-level
RPC capabilities, so universal L3/L4 feature equality is not the release bar.
Message validation remains init/explicit rather than per-read accounting;
document that distinction and bound new reflective operations within this sprint
instead of changing every Stable reader's semantics.
