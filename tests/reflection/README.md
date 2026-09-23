# Zig reflection conformance

`reflection_test.ts` feeds a native compiler request into the WASI Zig
generator, then compiles the generated modules and `consumer.zig` against the
project's pinned runtime. The same consumer runs natively and as a WASI command
in Wasmtime. Embedded descriptors and emitted messages must match byte for byte.
The test also compiles and runs seven further `zig test` suites, described
below, natively and under WASI: `registry_test`, `generated_builder_test`,
`builder_evolution_test`, `double_far_validation_test`, `dynamic_failure_test`,
`copy_limits_test`, and `fuzz_test`. `consumer.zig` additionally runs
`list_evolution_test`, `list_failure_test`, and `generic_list_test`.

Run from the repository root after `mise run build`:

```sh
mise exec -- deno test --allow-read --allow-write=build --allow-run tests/reflection/reflection_test.ts
```

The suite also runs through `mise run test`. Outputs remain under
`build/test/reflection-*/`, including the original compiler request, generated
source, executables, embedded schema request, and serialized messages.

The consumer reuses the shared `values`, `brands`, and `shared/common` feature
schemas. `reflection.capnp` adds every scalar width, additional list shapes, and
an interface method. Assertions cover:

- Lookup by type ID and field name, raw node identity, explicit field ordinals,
  explicit defaults, annotations, imported enum names, groups, generic parameter
  binding, and interface parameter/result schemas.
- Typed messages read dynamically; dynamic mutation read back through generated
  accessors. All scalar widths exercise nonzero XOR defaults.
- Text and Data defaults, binary bytes and embedded NUL, list and struct pointer
  defaults, and independent mutable copies of shared defaults.
- Union selection, inactive-member errors, groups, unknown enum ordinals,
  scalar/struct/Text/Data/enum/nested lists, and list bounds.
- Exact errors for missing names and IDs, wrong value types, malformed framing,
  and duplicate schema IDs.
- Physical growth when reopening a child written with an older schema,
  constrained AnyStruct pointer rejection, and null capabilities distinguished
  from capability-table index zero.

`registry_test.zig` also runs natively and under WASI. Its synthetic descriptors
test scalar and pointer offsets outside declared layouts, invalid union storage,
and owned descriptor lifetimes after the caller mutates and frees the input. The
allocator checks for leaks in both successful and rejected loads.

`list_evolution_test.zig` exercises reopening lists written with older layouts.
It covers smaller inline struct elements, preservation of unknown data and
pointer fields, byte/16-bit/32-bit/64-bit/pointer/Void list upgrades, empty
lists, nested lists, double-far source lists, and replacement with a larger
source struct. The list handle follows its updated parent pointer. Reading its
length and rejecting an invalid element index must leave serialized bytes
unchanged. Copying a struct view of a single byte into a standalone field
retains that byte. Every valid output is decoded independently by C++, including
unknown fields. Both populated and empty Boolean lists retain explicit rejection
assertions in Zig and C++, because the reference format does not permit this
upgrade.

`list_failure_test.zig` forces failures while cloning an old sibling and while
copying a larger replacement element. It verifies that the parent pointer and
all original reachable elements survive after replacement allocation has begun.
Unreachable allocation bytes are permitted after failure.

`generated_builder_test.zig` compiles and uses freshly generated ordinary
Builder APIs on native Zig and WASI. It checks allocation-free scalar reads,
Text/Data/enum defaults, union and group reopening, mutable defaults, struct and
list growth retaining unknown fields, typed deep copies including self-copy,
precise clearing, and constrained AnyPointer setters. Copying an original list
through scalar, pointer, Text, or Void views retains unknown struct fields,
including nested and type-erased readers and signed/float casts. It exercises
every allocation failure during a copy and verifies that the original
destination remains reachable. `asReader()` uses caller-owned `ReaderStorage`;
its segment index must stay at a stable address, and any builder mutation,
storage rebind, or storage deinitialization invalidates the borrowed readers.

`builder_evolution_test.zig` checks mutable primitive and pointer views of newer
struct-list encodings through near, single-far, and double-far pointers. Unknown
data and pointer fields must survive. It also checks strict Text list terminator
and UTF-8 errors. `double_far_validation_test.zig` checks graph traversal and
nesting limits, invalid children, counted validation failures, ambiguous legacy
tags, and zero-width struct-list traversal limits. Both suites run natively and
under WASI.

`dynamic_failure_test.zig` sweeps allocation failures through the dynamic
Builder API: struct replacement, growth, group copies, list element and pointer
replacement, and bounded copies must preserve the original reachable values,
union selection, and unknown physical fields at every failure point, and copy
options must reject expanded work before publishing storage.
`copy_limits_test.zig` checks the bounded copy options (output words, work
units, nesting, temporary allocation accounting, per-edge charging of shared
targets, and cyclic rejection) and canonical double-far struct copies.
`fuzz_test.zig` runs structured fuzzing over bounded registry loading, dynamic
mutation compared with generated readers, and double-far struct copies.
`mutation_corpus.zig` is the deterministic operation corpus that both generated
and dynamic builders emit and the C++ oracle replays; `double_far_fixture.zig`
holds hand-encoded canonical double-far frames that are independent of
`MessageBuilder`.

`oracle.c++` provides an independent reference check. It compares the complete
canonical binary representation of every embedded `schema::Node` with its node
in the original compiler request, including pointer defaults and annotations. It
loads those descriptors through C++ `SchemaLoader`, verifies imported types,
generic bindings, groups and interface methods, then decodes the emitted values
with the C++ dynamic API. This includes `builder-values.bin`, edited only
through the generated Builder API: default materialization, list edits, typed
self-copy, union-group reopening, and clear operations. It does not compile
generated fixture classes. The test then reruns the oracle with
`--inject-mismatch` and requires exit code 2, proving the mutation-replay gate
fails when its evidence is contradicted.

The ordinary toolchain and feature tests compare complete Zig output across
matching pinned native and Wasm generators, including metadata-free output with
`--no-reflection`. The new generated APIs intentionally differ from the
historical pristine generator even when metadata is disabled.

`generic_list_test.zig` tests accepted synthetic descriptors for `List(T)` and
nested lists where `T` resolves to a struct. It verifies pointer-list encoding,
mutable element growth, unknown-field preservation, and rejection of raw copies
to an incompatible inline struct list. The reference compiler currently rejects
this schema shape, so this is metadata API coverage rather than
compiler-generated C++ interoperability.
