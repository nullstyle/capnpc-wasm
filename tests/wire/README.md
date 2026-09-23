# Zig wire conformance

`tests/wire_conformance_test.ts` compiles the same `probe.zig` against two
runtime sources: the historical audit export at
`build/src/capnp-zig-historical/src/lib_core.zig` and the current pinned export
at `build/src/capnp-zig/src/lib_core.zig`. It also builds the current probe for
`wasm32-wasi` and runs it in Wasmtime. All emitted non-cyclic messages are
checked with the pinned reference `build/native/bin/capnp decode`.

Run `mise run test:wire` from the repository root; it is part of `mise run test`
and builds the native tools and prepares the Zig sources it needs. Each run
leaves its binary fixtures, probe executables, and C++ decoder output in
`build/test/wire-conformance-*/{upstream,patched,patched-wasi}/`. The variant
names date from the patch era: `upstream` is the historical audit revision
recorded in `generators/zig/historical-reference`, and `patched` is the current
pinned runtime, which now builds from the pristine reference with no local
patches. No generated schema code or audit scratch files are required. The
public SDKs and pristine reference sources are unchanged.

## Writer matrix and independent controls

The public `writeStructListInSegments` API is exercised with:

- Populated data lists under all-distinct, source=landing, and source=content
  segment assignments.
- A 257-element source=content list that exceeds the root segment's initial
  capacity and exercises relocation during allocation.
- Empty data lists, populated zero-width lists, and empty zero-width lists using
  distinct segments. A canonical in-content tag is required even when element
  storage occupies zero words.
- Data-plus-Text entries under all three assignments. Existing sentinel words
  force nonzero pad/content offsets and must survive unchanged.

Every list is reopened through `getAnyPointer().getStructList()`, checked for
its original location and shape, and populated entries are mutated through the
reopened builder. Zig validates the serialized messages and checks the final
lengths, scalar values, and strict Text reads.

The TypeScript harness independently checks framed segment sizes, source and
landing far pointers, tag kinds and offsets, element counts, data/pointer
widths, and list word counts excluding the content tag. C++ must decode every
current writer case to the same values. Current native and WASI outputs must
match byte for byte.

Same-segment and single-far controls still decode in both implementations and
must remain byte-identical to pristine upstream output. Hand-encoded canonical
double-far list and finite-tree fixtures independently check both Zig readers
and C++ decoding. The simple current writer output must equal the hand-encoded
canonical list exactly.

## Pristine writer evidence and retained legacy reads

The historical writer still emits Layout A: a struct-kind tag in the landing
pad, with no in-content element tag. Its populated outputs must fail C++
decoding with exit 1 and `expected ref->kind() == WirePointer::LIST [0 == 1]`.
Empty content segments fail earlier with the specific diagnostic
`Message contains double-far pointer to unknown segment`; the harness pins that
case separately. Crashes, other diagnostics, or an unexpected successful decode
fail the suite.

An independent hand-encoded Layout A fixture remains readable by both Zig
runtimes and must remain rejected by C++. The pristine writer's simple output
must equal that fixture exactly. This preserves the audit's W1 evidence while
the current runtime emits the canonical encoding. The historical commit is
recorded in `generators/zig/historical-reference`; advancing the live submodule
does not change this regression control. Generated-code consumers currently use
same-segment paths; this test targets the public allocation API.

## Validation and strict Text regressions

The historical runtime's original behavior remains an explicit oracle. The
current native and WASI runtimes must reject a canonical double-far struct cycle
at nesting limit 1 and traversal budget 2, independently and together. The
finite double-far tree charges four words, including its child; pristine Zig
charges only its two landing words. Near-pointer cycles and landing-pad limits
remain independent rejection controls.

Low-level `readText` keeps its lenient compatibility behavior. Generated Text
getters now use strict reads, including Text list elements; non-null Text must
carry a trailing NUL and valid UTF-8. The reflection/generated-Builder suite
covers these typed getters. The wire suite checks raw strict rejection and C++
rejection of missing terminators. Byte-list validation remains schema-agnostic,
so valid Data is accepted by `Message.init`.

Current writer cases reopen composite lists through primitive and Text-list
Builder views. C++ verifies the mutations and retained sibling fields, and the
same/single-far controls remain byte-identical to pristine output.

The cycle is intentionally not passed to `capnp decode`: its default-limit
printer also crashed on this input during the audit and exposes no tight-limit
flag. The historical W3 finding records a Zig limit-enforcement gap, not a claim
that the C++ command safely prints cyclic inputs. The finite double-far tree is
the C++ control.
