# Zig wire conformance

`tests/wire_conformance_test.ts` compiles the same `probe.zig` against two
runtime sources: pristine `ref/capnp-zig/src/lib_core.zig` and the patched
`build/src/capnp-zig/src/lib_core.zig`. It also builds the patched probe for
`wasm32-wasi` and runs it in Wasmtime. All emitted non-cyclic messages are
checked with the pinned reference `build/native/bin/capnp decode`.

Run from the repository root after building the native tools and preparing the
patched source through the regular pipeline:

```sh
mise run build:native
mise run build:zig
mise exec -- deno test --allow-read --allow-write=build --allow-run tests/wire_conformance_test.ts
```

The suite also runs through `mise run test`. Each run leaves its binary
fixtures, probe executables, and C++ decoder output in
`build/test/wire-conformance-*/{upstream,patched,patched-wasi}/`. No generated
schema code or audit scratch files are required. The public SDKs and pristine
reference sources are unchanged.

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
patched writer case to the same values. Patched native and WASI outputs must
match byte for byte.

Same-segment and single-far controls still decode in both implementations and
must remain byte-identical to pristine upstream output. Hand-encoded canonical
double-far list and finite-tree fixtures independently check both Zig readers
and C++ decoding. The simple patched writer output must equal the hand-encoded
canonical list exactly.

## Pristine writer evidence and retained legacy reads

The pristine writer still emits Layout A: a struct-kind tag in the landing pad,
with no in-content element tag. Its populated outputs must fail C++ decoding
with exit 1 and `expected ref->kind() == WirePointer::LIST [0 == 1]`. Empty
content segments fail earlier with the specific diagnostic
`Message contains double-far pointer to unknown segment`; the harness pins that
case separately. Crashes, other diagnostics, or an unexpected successful decode
fail the suite.

An independent hand-encoded Layout A fixture remains readable by both Zig
runtimes and must remain rejected by C++. The pristine writer's simple output
must equal that fixture exactly. This preserves the audit's W1 evidence while
patch 0004 changes only new emission to the canonical encoding. Generated-code
consumers currently use same-segment paths; this test targets the public
allocation API.

## Unchanged known validation gaps

The following W2/W3 expectations remain explicit in every runtime variant. They
are assertions, never skips or blanket acceptance of arbitrary exceptions. A
changed outcome fails the suite and requires reviewing the corresponding runtime
change.

- **W2: ordinary Text reads are lenient.** A byte list without a NUL terminator
  is accepted by `readText`, which generated Text getters currently use.
  `readTextStrict` must reject it with `InvalidTextPointer`, and C++ must reject
  it as non-NUL-terminated. `writeText` supplies a positive control accepted by
  all readers. The message validator is schema-agnostic: this is a typed
  Text-read assertion, not a requirement that byte-list validation reject Data.
- **W3: double-far struct traversal skips its pointer section.** A cyclic struct
  behind a canonical double-far root unexpectedly passes validation at nesting
  limit 1 and traversal budget 2, tested separately and together. The probe
  asserts exactly two charged words and follows only 1,000 children, with no
  further charge. Near-pointer cycles must reject under independent nesting and
  traversal limits; the double-far cycle must reject when its budget cannot
  cover the landing pad or its nesting limit disallows reading the root. A
  future routing fix should replace the known-acceptance assertions with the
  corresponding limit errors.

The cycle is intentionally not passed to `capnp decode`: its default-limit
printer also crashed on this input during the audit and exposes no tight-limit
flag. W3 records a Zig validation/limit-enforcement gap, not a claim that the
C++ command safely prints cyclic inputs. The finite double-far tree is the C++
control.
