# capnp-zig compatibility audit (consolidated)

> Historical document. The audit closed on 2026-09-08 against capnpc-wasm
> `1e095b4` and capnp-zig `08a3e3d`. It was moved here on 2026-09-22 with its
> code citations converted to permalinks at the audited revisions, its section
> numbers aligned with the findings table, and its untracked evidence marked as
> local only. The remediation sections describe a patch layer that no longer
> exists: every Zig patch has since been incorporated into capnp-zig, and the
> generator builds from the pristine pinned reference. Current behavior is
> documented in the [Zig generator guide](../../generators/zig/README.md) and
> the [synchronization history](../../patches/capnp-zig/README.md). Note added
> 2026-09-23: the pristine oracle binary `build/native/bin/capnpc-zig-upstream`
> cited under "Scope and method" is no longer produced (`scripts/build-zig.sh`
> removes stale copies); `build/native/bin/capnpc-zig` is built from the
> pristine pinned reference and needs no separate oracle.

Status: complete. Audit window closed 2026-09-08 against capnpc-wasm `main` at
`1e095b4`. Detailed evidence lived in three sub-reports under an untracked
`build/audit/` workspace, which is local only and not part of this repository:

- Code generation (`build/audit/codegen/findings.md`): generated-schema and
  Builder API gaps
- RPC and tooling (`build/audit/rpc/findings.md`): RPC surface, reflection, JSON
- Wire format (`build/audit/wire/findings.md`): double-far, text validation,
  resource limits

This document is the durable record; the reproduction commands recorded below
recreate the evidence from the pinned references.

## Remediation after the audit (2026-09-08)

The findings below describe the pinned upstream revision at the audit baseline.
Project patch
[0003](https://github.com/nullstyle/capnpc-wasm/blob/81525d22d17d545f136da5803fe234a7f9c64fff/patches/capnp-zig/0003-qualify-helper-views.patch)
now fixes finding #1's four helper-name collisions in the native and Wasm
generators. The shared
[helper-names corpus](../../tests/fixtures/features/README.md) compiles and runs
C++ and Zig consumers for all four cases, plus an enum-helper collision with a
same-named group. The separate Reader/Builder name failures remain outside this
patch. The audit harness now requires the four fixed probes to compile and
permits only the exact documented 0002/0003 output deltas when comparing against
the pristine generator.

A durable [wire conformance suite](../../tests/wire/README.md) now cross-checks
canonical cross-segment messages with the C++ reader. Project patch
[0004](https://github.com/nullstyle/capnpc-wasm/blob/81525d22d17d545f136da5803fe234a7f9c64fff/patches/capnp-zig/0004-standardize-double-far-lists.patch)
fixes finding #2's distinct-segment writer to emit the reference LIST-kind
landing tag and in-content element tag. Same-segment and single-far writing is
unchanged; legacy Layout A reads remain supported. Consumers obtain this runtime
fix by binding to the patched source copy, as described in the
[Zig generator notes](../../generators/zig/README.md).

The suite preserves the pristine runtime's Layout A rejection as an oracle and
requires successful C++ decoding from the patched writer. Strict Text rejection
and the double-far struct limit gap remain explicit assertions for open
findings; neither reader behavior is changed by 0004. The original audit
evidence and distinctions below are preserved.

Verification after patch 0003 passed: `mise run test`, `mise run check`, and the
updated audit `run_checks.py`. The full suites include uncached Go SDK tests
(`-count=1 -mod=readonly`), five Zig helper-name use tests, and eight wire
conformance steps. Exact upstream parity remains for the unaffected basic and
values scenarios. All reference checkouts remain pristine. The browser matrix
was not rerun; no TypeScript runtime or bundle code changed.

Verification after patch 0004 also passed: `mise run test`, `mise run check`,
the unchanged generator-output audit expectations, and 15 focused upstream
runtime tests. The wire suite now has 59 steps across pristine native, patched
native, and patched WASI. Ten distinct-segment writer cases cover segment
aliasing, empty and zero-width lists, pointer fields, storage growth, and
mutable reopening. Patched native/WASI bytes match and decode successfully with
C++; same-segment and single-far output remains byte-identical to pristine
upstream.

### Native package and generated API remediation

The native package now contains the reflection and wire changes introduced by
patches 0001–0006. Patch 0007 synchronizes the subsequent implementation back
into the Wasm build without modifying the pinned reference. Findings #3–#9 have
focused compile-and-use or wire regressions: ordinary Builder getters, pointer
reopening/copy/clear and reader views; double-far struct validation; strict Text
reads including lists; concrete generic collections and recursion; constrained
ordinary setters; nested pipeline helpers; and qualified inherited methods.

Typed generic views remain additive, and generic RPC clients are still erased.
The low-level raw pointer escape remains available. Builder readers borrow an
explicit storage object and expire on mutation; they are not owned snapshots. No
orphan/adopt API or per-read traversal accounting is claimed. The historical
findings below remain a description of the original pinned revision, not the
current patched implementation.

The current generator intentionally changes source output beyond reflection, so
exact equality with the old pristine Zig generator is no longer expected. Exact
native/Wasm equality, generated-code execution, C++ decoding, and native
cross-language RPC tests serve different purposes and are reported separately.

Validation completed on 2026-09-08: native Debug and ReleaseSafe suites passed
all 185 build steps (ReleaseSafe reported 1,954 tests passed and one skipped).
The native C++/Go/Rust RPC matrix passed 31 cases with five documented skips and
no failures. Generated-file, API compatibility/closure, documentation, and
clean-package checks passed; the dedicated wire-evolution fuzz target completed
10,018 iterations without failure. Downstream `mise run check` passed, including
native/WASI generated consumers and independent C++ descriptor/message checks.
All 188 native source files matched the prepared Wasm source tree byte for byte;
the pinned reference checkouts remained pristine. Browser runtime sources were
unchanged, so the browser matrix was not rerun.

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
generator behavior across hosts. It cannot detect any finding below, because the
native generator and runtime share the same defects. Interop and
API-completeness require compile-and-run tests against the reference
implementations, which is what this audit adds.

### What was verified on 2026-09-08

- `python3 build/audit/codegen/run_checks.py` — 8 expected Zig compile failures
  reproduced; `operations`/`generics`/`constrained` checks pass;
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
  performed for any implementation. RPC findings are source-plus-probe confirmed
  only.

## Prioritized findings

| #  | Finding                                                                                                                                         | Class                 | Priority |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------- |
| 1  | Four legal schema name patterns generate Zig that cannot compile; C++, Rust, and Go all compile them                                            | Generator defect      | **P1**   |
| 2  | Public cross-segment list writer emits a nonstandard double-far encoding that the reference C++ reader rejects                                  | Wire-interop defect   | **P1**   |
| 3  | Builder API omissions: no ordinary getters, no reopen/copy of existing pointer fields, no Builder-to-Reader, no Builder `which`                 | Missing generated API | **P2**   |
| 4  | Validation walk skips pointer sections below double-far structs; crafted cyclic input bypasses nesting/traversal limits                         | Validation/limit gap  | **P2**   |
| 5  | Generated Text getters accept non-NUL-terminated text the reference rejects                                                                     | Validation strictness | **P2**   |
| 6  | Generic type bindings erased except direct struct slots (`brands()` sidecars); lists of generics and recursive generics lose typing vs C++/Rust | Type fidelity         | **P2**   |
| 7  | Constrained AnyStruct ordinary API accepts wrong-pointer-kind setters (`setShapeText` on an AnyStruct field)                                    | API correctness       | **P2**   |
| 8  | Nested-result capability pipelines have no generated helpers (all three mature generators produce them)                                         | RPC ergonomics        | **P2**   |
| 9  | Legal inherited same-name methods are rejected (`DuplicateGeneratedName`)                                                                       | Generator limitation  | **P2**   |
| 10 | Generic RPC interfaces and implicit method generics erased vs C++ (Rust partial, Go erased)                                                     | RPC typing            | P3       |
| 11 | Streaming: real protocol, but no deferred handler and count-based (not byte-window) flow control                                                | RPC ergonomics        | P3       |
| 12 | `capnp/stream.zig` import not shippable without separately generating the standard schema                                                       | Packaging             | P3       |
| 13 | No generated type IDs/dynamic access/schema-aware debugging vs C++/Rust/Go; JSON manifest names are descriptors only                            | Tooling               | P3       |

## Code generation findings

### 1. Legal schemas generate successfully but produce uncompilable Zig (P1)

Eight naming probes were compiled across all four generators. Four cases fail in
Zig while compiling in **all three** mature generators: a union-holding
`WhichTag` (generated tag enum shadows the struct), `EnumOrdinals` (enum field),
`NestedLists` (`List(List(UInt32))`), and `PointerKinds` (`AnyStruct`). Root
cause: file-scoped Reader/Builder and helper-view emission uses unqualified
names
([struct_gen.zig:129](https://github.com/nullstyle/capnp-zig/blob/08a3e3d43288f8305f338a09e4473758b1188ca5/src/capnpc-zig/struct_gen.zig#L129),
emission at :1748, :1982, :2106, :2274, :2320, :3328), and
`name_validation.zig`'s nested-declaration scope is not fed the reserved
Reader/Builder names
([name_validation.zig:69](https://github.com/nullstyle/capnp-zig/blob/08a3e3d43288f8305f338a09e4473758b1188ca5/src/capnpc-zig/name_validation.zig#L69),
:135-136).

The `Reader`/`Builder` top-level and nested cases also fail in C++ (same-name
member), while Rust and Go compile them — preserve that distinction. This
project's patch 0002 already fixed exactly this class of ambiguity for `Brands`;
the sibling cases above remain. Impact: browser/SDK generation returns success
plus unusable source. Byte-parity tests cannot catch this.

### 3. Builder API omissions (P2)

Executable `@hasDecl` assertions on an ordinary fixture confirm the Builder has
setters, `initX`, presence checks, and group/sidecar access, but lacks: ordinary
getters (scalar/Text/Data), mutable reopen accessors for existing struct/list
fields (only allocating `initX`), typed set/copy from Readers,
`asReader`/`intoReader`, Builder `which`/`whichOrdinal`, and clear/adopt
conveniences. Primary emission:
[struct_gen.zig:3324](https://github.com/nullstyle/capnp-zig/blob/08a3e3d43288f8305f338a09e4473758b1188ca5/src/capnpc-zig/struct_gen.zig#L3324)
(lists :3396; struct fields return before the setter path :3483). C++ generates
mutable get/set/init/adopt/disown
([capnpc-c++.c++:1743](https://github.com/capnproto/capnproto/blob/851c45bb39c34c3f20f9d9ebe9f34a7e39109b6f/c++/src/capnp/compiler/capnpc-c++.c++#L1743));
Rust generates Builder getters and reader conversion
([codegen.rs:2100](https://github.com/capnproto/capnproto-rust/blob/81bc1b815d0f450c9114f9cc2e2274182d210df2/capnpc/src/codegen.rs#L2100),
:2377); Go's single mutable type has getters and `Which`.

Practical cost: editing an existing message, copying an opaque subtree (which
must preserve unknown newer fields), or read-while-building forces raw
`_builder` pointer APIs or serialize/reparse. The runtime does have
`cloneAnyPointer`; the gap is the generated typed surface. Do not overstate:
presence methods exist; orphan adopt/disown is specifically C++'s model.

### 6. Generic typing is partial (P2)

Direct `Box(Text)` fields get typed `brands()` sidecars; `List(Box(Text))` and
recursive `Link(Text)` get none, and ordinary getters are erased to
`AnyPointerReader`. `concreteBrand` accepts only direct struct slots
([struct_gen.zig:559](https://github.com/nullstyle/capnp-zig/blob/08a3e3d43288f8305f338a09e4473758b1188ca5/src/capnpc-zig/struct_gen.zig#L559));
recursive sidecars are explicitly unsupported
([brand_fidelity.zig:51](https://github.com/nullstyle/capnp-zig/blob/08a3e3d43288f8305f338a09e4473758b1188ca5/src/capnpc-zig/brand_fidelity.zig#L51)).
C++ retains `Box<capnp::Text>`, `List<Box<...>>`, `Link<...>` in public getters
(compiled evidence); Rust retains branded readers/lists; **Go also erases** to
`capnp.Ptr` — the gap is against C++/Rust.

### 7. Constrained AnyStruct ordinary API exposes wrong-kind setters (P2)

For `shape @0 :AnyStruct`, the ordinary Builder emits
`setShapeText`/`setShapeData`/`setShapeCapability`; executed probe sets Text,
roundtrips, and the constrained sidecar then rejects the value
(`InvalidRootPointer`). The ordinary path ignores constraint metadata
([struct_gen.zig:3515](https://github.com/nullstyle/capnp-zig/blob/08a3e3d43288f8305f338a09e4473758b1188ca5/src/capnpc-zig/struct_gen.zig#L3515),
:4014). C++ and Go constrain their APIs; **the pinned Rust also erases** here —
not uniquely immature Zig, but an internally inconsistent generated surface.

### Not defects

Unknown enum ordinals roundtrip (`enumOrdinals()`, list `get/setOrdinal`,
`whichOrdinal`); numeric/pointer defaults, presence, and union guards pass;
typed getters correctly return `InvalidEnumValue` for unknown values (Rust
behaves comparably; C++/Go use integer-valued enums). Separate Reader/Builder
types, `try` style, and enum naming are idiom, not gaps.

## Wire-format findings

All three findings rerun and confirmed 2026-09-08; see the wire report (local
only: `build/audit/wire/findings.md`) for reproduction transcripts.

### 2. Nonstandard double-far composite-list emission (P1)

`writeStructListInSegments` with distinct landing/content segments
([message.zig:3433](https://github.com/nullstyle/capnp-zig/blob/08a3e3d43288f8305f338a09e4473758b1188ca5/src/serialization/message.zig#L3433))
emits a landing pad of `[far -> raw elements, struct-kind tag]` — internally
called "Layout A"
([message.zig:995](https://github.com/nullstyle/capnp-zig/blob/08a3e3d43288f8305f338a09e4473758b1188ca5/src/serialization/message.zig#L995)).
The reference encoding copies the original pointer's kind into the tag (LIST for
a composite list) and points pad[0] at content that begins with the in-content
element tag
([layout.c++:1084](https://github.com/capnproto/capnproto/blob/851c45bb39c34c3f20f9d9ebe9f34a7e39109b6f/c++/src/capnp/layout.c++#L1084)).
C++ rejects Zig's bytes: `expected ref->kind() == WirePointer::LIST [0 == 1]`
([layout.c++:2298](https://github.com/capnproto/capnproto/blob/851c45bb39c34c3f20f9d9ebe9f34a7e39109b6f/c++/src/capnp/layout.c++#L2298)).
Zig's reader and validator accept Layout A, so Zig roundtrips hide the defect.

Current exposure is limited to direct callers of the public `...InSegments` APIs
with distinct segments — generated code and `cloneAnyPointer` use same-segment
paths that emit standard encodings — but any future runtime segmentation change
would silently emit reference-rejected messages.

### 4. Validation walk skips double-far struct pointer sections; limits bypassable (P2)

The init-time walk (the documented untrusted-input entry point) routes
struct-kind double-far tags to `validateInlineCompositeTag` instead of
`validateStructPointer`
([message.zig:1265](https://github.com/nullstyle/capnp-zig/blob/08a3e3d43288f8305f338a09e4473758b1188ca5/src/serialization/message.zig#L1265)),
reading genuine standard double-far structs as zero-element lists and never
walking their pointer sections. Demonstrated: a valid finite tree charges only 2
words and its child pointer goes unvisited; a cyclic self-referential struct
passes `init` with `nesting_limit = 1`/`traversal_limit_words = 2` and
`readStruct` then follows the loop 1000 times uncharged. Ordinary structs are
walked correctly
([message.zig:1317](https://github.com/nullstyle/capnp-zig/blob/08a3e3d43288f8305f338a09e4473758b1188ca5/src/serialization/message.zig#L1317)),
and `validateStructPointer` already supports the needed `content_override` — the
defect is dispatch, not missing machinery. C++ enforces nesting per read ("too
deeply-nested or contains cycles",
[layout.c++:2285](https://github.com/capnproto/capnproto/blob/851c45bb39c34c3f20f9d9ebe9f34a7e39109b6f/c++/src/capnp/layout.c++#L2285));
under default tool limits the `capnp decode` binary itself segfaults on the
cycle, so claim a Zig limit-enforcement gap, not a safety inversion or an
unbounded exploit. The finite control confirms limits work on valid data and
Zig/C++ decode it identically.

### 5. Text NUL leniency (P2)

Generated Text getters call `readText`, which strips a NUL only if present and
does not validate UTF-8
([struct_gen.zig:2463](https://github.com/nullstyle/capnp-zig/blob/08a3e3d43288f8305f338a09e4473758b1188ca5/src/capnpc-zig/struct_gen.zig#L2463));
`readTextStrict` enforces both but is not what generated code uses. C++ rejects
non-NUL-terminated text on every read
([layout.c++:2486](https://github.com/capnproto/capnproto/blob/851c45bb39c34c3f20f9d9ebe9f34a7e39109b6f/c++/src/capnp/layout.c++#L2486)).
Zig's own writer emits valid text; this is acceptance of hostile/buggy producer
bytes.

## RPC and tooling findings

Evidence and qualifications in the RPC report (local only:
`build/audit/rpc/findings.md`); probes were not rerun on 2026-09-08.

**Present and working — do not report as missing:** generated
Client/Server/VTable, ordinary inheritance with diamond dedup, capability
pipelining for direct interface results (incl. `callXPipelined`/`Pipeline`
getters), streaming call protocol with in-flight counting and drain,
cancellation/deadlines (real Finish + late-Return absorption), persistence
Save/Restore helpers, retained answer lifetimes (experimental), and interface
IDs.

Gaps: nested-result pipelines lack generated helpers while the runtime accepts
arbitrary transform paths (C++/Rust/Go generate them for the exact probe — the
one all-three comparison); generic RPC interfaces are erased (C++ typed, Rust
typed interfaces but erased implicit method generics, Go erased); legal
inherited same-name methods are rejected pre-generation (C++/Rust compile; Go
also fails); streaming handlers acknowledge synchronously with no deferred
handler and a count cap instead of an adaptive byte window; generated streaming
output imports `capnp/stream.zig`, which the runtime does not ship; generated
data structs lack type IDs/dynamic access/schema-aware debug (C++ SchemaLoader/
DynamicStruct, Rust Introspect + dynamic + Debug, Go TypeIDs + registered schema
blobs) — though runtime schema primitives and manifest-recoverable IDs exist;
the JSON manifest emits descriptor names only (compare with C++ JsonCodec
specifically; Rust/Go equivalents were not established). Upstream docs' claims
that relative imports work and Brands/PointerKinds collisions are rejected are
overbroad for this pin; `lib_core.zig` does export a reduced RPC surface
contrary to the docs' module table.

## Regression candidates

1. Compile-and-use Zig tests for the four all-mature-pass naming cases
   (`WhichTag`, `EnumOrdinals`, `NestedLists`, `PointerKinds`); treat nested
   Reader/Builder collisions as rejection/renaming policy with the C++ exception
   documented.
2. A wire conformance check that decodes Zig-written cross-segment messages with
   the reference C++ reader (catches Layout-A class defects that Zig roundtrips
   hide), plus a hostile-input suite: cyclic double-far under tight limits,
   non-NUL text, deep chains.
3. `List(Box(Text))` and `Link(Text)` in any generic-support matrix, with
   callers asserting intended return types.
4. Copy/reopen/Builder-read tests with a schema-evolution pair so subtree copies
   must retain an unknown field.
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
- `build/audit/validation/` — finite budget control (`budget.zig`, `tree.capnp`,
  `tree.bin`).
- `build/audit/metadata/` — four languages' output over a metadata-bearing
  request; scratch only, feeding the RPC report's reflection section.
