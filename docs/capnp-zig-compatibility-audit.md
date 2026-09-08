# capnp-zig compatibility audit (consolidated)

Status: complete. Audit window closed 2026-09-08 against capnpc-wasm `main` at
`1e095b4`. Detailed evidence lives in three sub-reports under the (untracked)
audit workspace, summarized here:

- [Code generation](../build/audit/codegen/findings.md) — generated-schema and Builder API gaps
- [RPC and tooling](../build/audit/rpc/findings.md) — RPC surface, reflection, JSON
- [Wire format](../build/audit/wire/findings.md) — double-far, text validation, resource limits

This document is the durable record; if the `build/` workspace is regenerated,
the sub-reports' reproduction commands (recorded below and in each report)
recreate the evidence from the pinned references.

## Remediation after the audit (2026-09-08)

The findings below describe the pinned upstream revision at the audit baseline.
Project patch [0003](../patches/capnp-zig/0003-qualify-helper-views.patch) now
fixes finding #1's four helper-name collisions in the native and Wasm
generators. The shared [helper-names corpus](../tests/fixtures/features/README.md)
compiles and runs C++ and Zig consumers for all four cases, plus an enum-helper
collision with a same-named group. The separate Reader/Builder name failures
remain outside this patch. The audit harness now requires the four fixed probes
to compile and permits only the exact documented 0002/0003 output deltas when
comparing against the pristine generator.

A durable [wire conformance suite](../tests/wire/README.md) now cross-checks
canonical cross-segment messages with the C++ reader. Project patch
[0004](../patches/capnp-zig/0004-standardize-double-far-lists.patch) fixes
finding #2's distinct-segment writer to emit the reference LIST-kind landing tag
and in-content element tag. Same-segment and single-far writing is unchanged;
legacy Layout A reads remain supported. Consumers obtain this runtime fix by
binding to the patched source copy, as described in the
[Zig generator notes](../generators/zig/README.md).

The suite preserves the pristine runtime's Layout A rejection as an oracle and
requires successful C++ decoding from the patched writer. Strict Text rejection
and the double-far struct limit gap remain explicit assertions for open
findings; neither reader behavior is changed by 0004. The original audit
evidence and distinctions below are preserved.

Verification after patch 0003 passed: `mise run test`, `mise run check`, and
the updated audit `run_checks.py`. The full suites include uncached Go SDK tests
(`-count=1 -mod=readonly`), five Zig helper-name use tests, and eight wire
conformance steps. Exact upstream parity remains for the unaffected basic and
values scenarios. All reference checkouts remain pristine. The browser matrix
was not rerun; no TypeScript runtime or bundle code changed.

Verification after patch 0004 also passed: `mise run test`, `mise run check`,
the unchanged generator-output audit expectations, and 15 focused upstream
runtime tests. The wire suite now has 59 steps across pristine native, patched
native, and patched WASI. Ten distinct-segment writer cases cover segment
aliasing, empty and zero-width lists, pointer fields, storage growth, and mutable
reopening. Patched native/WASI bytes match and decode successfully with C++;
same-segment and single-far output remains byte-identical to pristine upstream.

## Scope and method

Audited the pinned capnp-zig generator and runtime (`ref/capnp-zig` at
`08a3e3d43288f8305f338a09e4473758b1188ca5`) against the repository's pinned
mature implementations: C++ (`ref/capnproto` at `851c45bb`), Rust
(`ref/capnproto-rust` at `81bc1b8`), and Go (`ref/go-capnp` at `5d74edb`). The
native Zig generator ran in two configurations: `build/native/bin/capnpc-zig`
(carrying this project's two compatibility patches) and
`build/native/bin/capnpc-zig-upstream` (pristine oracle). No reference checkout
was modified.

The audit distinguishes three kinds of claims:

1. **Executed** — a probe compiled and ran, with recorded output.
2. **Source-confirmed** — primary-source line citation in the pinned checkouts.
3. **Cross-language compiled** — generated C++/Rust/Go output was compiled with
   the pinned toolchains, not just inspected.

Native/Wasm byte parity — which this project's tests verify — proves the same
generator behavior across hosts. It cannot detect any finding below, because
the native generator and runtime share the same defects. Interop and
API-completeness require compile-and-run tests against the reference
implementations, which is what this audit adds.

### What was verified on 2026-09-08

- `python3 build/audit/codegen/run_checks.py` — 8 expected Zig compile
  failures reproduced; `operations`/`generics`/`constrained` checks pass;
  patched-vs-upstream byte parity holds for every case (exactly modulo patch
  0002's intended `@This().Brands` qualification in `generics`). The harness's
  earlier byte-equality assertion was over-broad for that case and was fixed.
- `python3 build/audit/codegen/compare_names.py` and `compare_features.py` —
  regenerated and compiled C++/Rust/Go output for all probes; results match the
  recorded cross-language table.
- Wire probes (`build/audit/wire/probe.zig`), the finite budget control
  (`build/audit/validation/budget.zig`), and `capnp decode` cross-checks all
  rerun; outputs recorded in the wire report.
- The RPC audit's probes were completed earlier against the same pinned
  revisions and were not rerun; no fresh network RPC conformance run was
  performed for any implementation. RPC findings are source-plus-probe
  confirmed only.

## Prioritized findings

| # | Finding | Class | Priority |
|---|---------|-------|----------|
| 1 | Four legal schema name patterns generate Zig that cannot compile; C++, Rust, and Go all compile them | Generator defect | **P1** |
| 2 | Public cross-segment list writer emits a nonstandard double-far encoding that the reference C++ reader rejects | Wire-interop defect | **P1** |
| 3 | Builder API omissions: no ordinary getters, no reopen/copy of existing pointer fields, no Builder-to-Reader, no Builder `which` | Missing generated API | **P2** |
| 4 | Validation walk skips pointer sections below double-far structs; crafted cyclic input bypasses nesting/traversal limits | Validation/limit gap | **P2** |
| 5 | Generated Text getters accept non-NUL-terminated text the reference rejects | Validation strictness | **P2** |
| 6 | Generic type bindings erased except direct struct slots (`brands()` sidecars); lists of generics and recursive generics lose typing vs C++/Rust | Type fidelity | **P2** |
| 7 | Constrained AnyStruct ordinary API accepts wrong-pointer-kind setters (`setShapeText` on an AnyStruct field) | API correctness | **P2** |
| 8 | Nested-result capability pipelines have no generated helpers (all three mature generators produce them) | RPC ergonomics | **P2** |
| 9 | Legal inherited same-name methods are rejected (`DuplicateGeneratedName`) | Generator limitation | **P2** |
| 10 | Generic RPC interfaces and implicit method generics erased vs C++ (Rust partial, Go erased) | RPC typing | P3 |
| 11 | Streaming: real protocol, but no deferred handler and count-based (not byte-window) flow control | RPC ergonomics | P3 |
| 12 | `capnp/stream.zig` import not shippable without separately generating the standard schema | Packaging | P3 |
| 13 | No generated type IDs/dynamic access/schema-aware debugging vs C++/Rust/Go; JSON manifest names are descriptors only | Tooling | P3 |

## Code generation findings

### 1. Legal schemas generate successfully but produce uncompilable Zig (P1)

Eight naming probes were compiled across all four generators. Four cases fail
in Zig while compiling in **all three** mature generators: a union-holding
`WhichTag` (generated tag enum shadows the struct), `EnumOrdinals` (enum
field), `NestedLists` (`List(List(UInt32))`), and `PointerKinds` (`AnyStruct`).
Root cause: file-scoped Reader/Builder and helper-view emission uses
unqualified names ([struct_gen.zig:129](../ref/capnp-zig/src/capnpc-zig/struct_gen.zig:129),
emission at :1748, :1982, :2106, :2274, :2320, :3328), and
`name_validation.zig`'s nested-declaration scope is not fed the reserved
Reader/Builder names ([name_validation.zig:69](../ref/capnp-zig/src/capnpc-zig/name_validation.zig:69),
:135-136).

The `Reader`/`Builder` top-level and nested cases also fail in C++ (same-name
member), while Rust and Go compile them — preserve that distinction. This
project's patch 0002 already fixed exactly this class of ambiguity for
`Brands`; the sibling cases above remain. Impact: browser/SDK generation
returns success plus unusable source. Byte-parity tests cannot catch this.

### 2. Builder API omissions (P2)

Executable `@hasDecl` assertions on an ordinary fixture confirm the Builder
has setters, `initX`, presence checks, and group/sidecar access, but lacks:
ordinary getters (scalar/Text/Data), mutable reopen accessors for existing
struct/list fields (only allocating `initX`), typed set/copy from Readers,
`asReader`/`intoReader`, Builder `which`/`whichOrdinal`, and clear/adopt
conveniences. Primary emission: [struct_gen.zig:3324](../ref/capnp-zig/src/capnpc-zig/struct_gen.zig:3324)
(lists :3396; struct fields return before the setter path :3483). C++ generates
mutable get/set/init/adopt/disown ([capnpc-c++.c++:1743](../ref/capnproto/c++/src/capnp/compiler/capnpc-c++.c++:1743));
Rust generates Builder getters and reader conversion
([codegen.rs:2100](../ref/capnproto-rust/capnpc/src/codegen.rs:2100), :2377);
Go's single mutable type has getters and `Which`.

Practical cost: editing an existing message, copying an opaque subtree (which
must preserve unknown newer fields), or read-while-building forces raw
`_builder` pointer APIs or serialize/reparse. The runtime does have
`cloneAnyPointer`; the gap is the generated typed surface. Do not overstate:
presence methods exist; orphan adopt/disown is specifically C++'s model.

### 3. Generic typing is partial (P2)

Direct `Box(Text)` fields get typed `brands()` sidecars; `List(Box(Text))` and
recursive `Link(Text)` get none, and ordinary getters are erased to
`AnyPointerReader`. `concreteBrand` accepts only direct struct slots
([struct_gen.zig:559](../ref/capnp-zig/src/capnpc-zig/struct_gen.zig:559));
recursive sidecars are explicitly unsupported
([brand_fidelity.zig:51](../ref/capnp-zig/src/capnp-zig/brand_fidelity.zig:51)).
C++ retains `Box<capnp::Text>`, `List<Box<...>>`, `Link<...>` in public getters
(compiled evidence); Rust retains branded readers/lists; **Go also erases** to
`capnp.Ptr` — the gap is against C++/Rust.

### 4. Constrained AnyStruct ordinary API exposes wrong-kind setters (P2)

For `shape @0 :AnyStruct`, the ordinary Builder emits `setShapeText`/`setShapeData`/`setShapeCapability`;
executed probe sets Text, roundtrips, and the constrained sidecar then rejects
the value (`InvalidRootPointer`). The ordinary path ignores constraint metadata
([struct_gen.zig:3515](../ref/capnp-zig/src/capnpc-zig/struct_gen.zig:3515),
:4014). C++ and Go constrain their APIs; **the pinned Rust also erases** here —
not uniquely immature Zig, but an internally inconsistent generated surface.

### Not defects

Unknown enum ordinals roundtrip (`enumOrdinals()`, list
`get/setOrdinal`, `whichOrdinal`); numeric/pointer defaults, presence, and
union guards pass; typed getters correctly return `InvalidEnumValue` for
unknown values (Rust behaves comparably; C++/Go use integer-valued enums).
Separate Reader/Builder types, `try` style, and enum naming are idiom, not
gaps.

## Wire-format findings

All three findings rerun and confirmed 2026-09-08; see the
[wire report](../build/audit/wire/findings.md) for reproduction transcripts.

### 5. Nonstandard double-far composite-list emission (P1)

`writeStructListInSegments` with distinct landing/content segments
([message.zig:3433](../ref/capnp-zig/src/serialization/message.zig:3433))
emits a landing pad of `[far -> raw elements, struct-kind tag]` — internally
called "Layout A" ([message.zig:995](../ref/capnp-zig/src/serialization/message.zig:995)).
The reference encoding copies the original pointer's kind into the tag (LIST
for a composite list) and points pad[0] at content that begins with the
in-content element tag ([layout.c++:1084](../ref/capnproto/c++/src/capnp/layout.c++:1084)).
C++ rejects Zig's bytes: `expected ref->kind() == WirePointer::LIST [0 == 1]`
([layout.c++:2298](../ref/capnproto/c++/src/capnp/layout.c++:2298)). Zig's
reader and validator accept Layout A, so Zig roundtrips hide the defect.

Current exposure is limited to direct callers of the public `...InSegments`
APIs with distinct segments — generated code and `cloneAnyPointer` use
same-segment paths that emit standard encodings — but any future runtime
segmentation change would silently emit reference-rejected messages.

### 6. Validation walk skips double-far struct pointer sections; limits bypassable (P2)

The init-time walk (the documented untrusted-input entry point) routes
struct-kind double-far tags to `validateInlineCompositeTag` instead of
`validateStructPointer` ([message.zig:1265](../ref/capnp-zig/src/serialization/message.zig:1265)),
reading genuine standard double-far structs as zero-element lists and never
walking their pointer sections. Demonstrated: a valid finite tree charges only
2 words and its child pointer goes unvisited; a cyclic self-referential struct
passes `init` with `nesting_limit = 1`/`traversal_limit_words = 2` and
`readStruct` then follows the loop 1000 times uncharged. Ordinary structs are
walked correctly ([message.zig:1317](../ref/capnp-zig/src/serialization/message.zig:1317)),
and `validateStructPointer` already supports the needed `content_override` —
the defect is dispatch, not missing machinery. C++ enforces nesting per read
("too deeply-nested or contains cycles", [layout.c++:2285](../ref/capnproto/c++/src/capnp/layout.c++:2285));
under default tool limits the `capnp decode` binary itself segfaults on the
cycle, so claim a Zig limit-enforcement gap, not a safety inversion or an
unbounded exploit. The finite control confirms limits work on valid data and
Zig/C++ decode it identically.

### 7. Text NUL leniency (P2)

Generated Text getters call `readText`, which strips a NUL only if present and
does not validate UTF-8 ([struct_gen.zig:2463](../ref/capnp-zig/src/capnpc-zig/struct_gen.zig:2463));
`readTextStrict` enforces both but is not what generated code uses. C++
rejects non-NUL-terminated text on every read
([layout.c++:2486](../ref/capnproto/c++/src/capnp/layout.c++:2486)). Zig's own
writer emits valid text; this is acceptance of hostile/buggy producer bytes.

## RPC and tooling findings

Evidence and qualifications in the [RPC report](../build/audit/rpc/findings.md);
probes were not rerun on 2026-09-08.

**Present and working — do not report as missing:** generated Client/Server/VTable,
ordinary inheritance with diamond dedup, capability pipelining for direct
interface results (incl. `callXPipelined`/`Pipeline` getters), streaming call
protocol with in-flight counting and drain, cancellation/deadlines (real
Finish + late-Return absorption), persistence Save/Restore helpers, retained
answer lifetimes (experimental), and interface IDs.

Gaps: nested-result pipelines lack generated helpers while the runtime accepts
arbitrary transform paths (C++/Rust/Go generate them for the exact probe — the
one all-three comparison); generic RPC interfaces are erased (C++ typed, Rust
typed interfaces but erased implicit method generics, Go erased); legal
inherited same-name methods are rejected pre-generation (C++/Rust compile; Go
also fails); streaming handlers acknowledge synchronously with no deferred
handler and a count cap instead of an adaptive byte window; generated streaming
output imports `capnp/stream.zig`, which the runtime does not ship; generated
data structs lack type IDs/dynamic access/schema-aware debug (C++ SchemaLoader/
DynamicStruct, Rust Introspect + dynamic + Debug, Go TypeIDs + registered
schema blobs) — though runtime schema primitives and manifest-recoverable IDs
exist; the JSON manifest emits descriptor names only (compare with C++
JsonCodec specifically; Rust/Go equivalents were not established). Upstream
docs' claims that relative imports work and Brands/PointerKinds collisions are
rejected are overbroad for this pin; `lib_core.zig` does export a reduced RPC
surface contrary to the docs' module table.

## Regression candidates

1. Compile-and-use Zig tests for the four all-mature-pass naming cases
   (`WhichTag`, `EnumOrdinals`, `NestedLists`, `PointerKinds`); treat nested
   Reader/Builder collisions as rejection/renaming policy with the C++
   exception documented.
2. A wire conformance check that decodes Zig-written cross-segment messages
   with the reference C++ reader (catches Layout-A class defects that Zig
   roundtrips hide), plus a hostile-input suite: cyclic double-far under tight
   limits, non-NUL text, deep chains.
3. `List(Box(Text))` and `Link(Text)` in any generic-support matrix, with
   callers asserting intended return types.
4. Copy/reopen/Builder-read tests with a schema-evolution pair so subtree
   copies must retain an unknown field.
5. Keep unknown-enum raw ordinal roundtrip tests to protect forward
   compatibility.
6. Wrong-pointer-kind setter path for constrained AnyPointer fields if the
   ordinary API ever becomes constrained.

## Artifact map

- `build/audit/codegen/` — naming/operations/generics/constrained probes,
  per-language generated output, logs; `run_checks.py` (byte-parity +
  expected-failure harness), `compare_names.py`/`compare_features.py`
  (cross-language compile matrix).
- `build/audit/rpc/` — RPC schema probes, four languages' generated output,
  inheritance/streaming evidence.
- `build/audit/wire/` — `probe.zig` (three findings), `probe.capnp`, emitted
  binaries, layout-variant controls; `findings.md`.
- `build/audit/validation/` — finite budget control (`budget.zig`,
  `tree.capnp`, `tree.bin`).
- `build/audit/metadata/` — four languages' output over a metadata-bearing
  request; scratch only, feeding the RPC report's reflection section.
