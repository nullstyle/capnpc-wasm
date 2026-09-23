# Zig generator

`mise run build:zig` compiles the pinned `ref/capnp-zig/src/main.zig` directly
for the native host and `wasm32-wasi` (Zig's name for WASI Preview 1). The
artifacts are `build/native/bin/capnpc-zig` and
`build/wasm/bin/capnpc-zig.wasm`. Both use the upstream request reader,
validator, and generator from the pristine pinned source. The former local
compatibility patches and reflection copies are now part of capnp-zig itself.
The build also exports the separately pinned historical audit revision under
`build/src/capnp-zig-historical` for the wire conformance probes; it no longer
builds a command from it. There is no second emitter or RPC transport
dependency.

Each compile writes a stamp under `build/zig/` recording the Zig version, the
exported source revision, the flags, and the build script itself. A repeated
`mise run build:zig` skips compiles whose stamp matches, runs the native and
WASI compiles concurrently otherwise, and replaces the copies under
`build/native/bin` and `build/wasm/bin` only when their bytes change. The Zig
cache under `build/zig/cache` is disposable; test compiles leave temporary build
directories in `build/zig/cache/tmp`, so delete it when it grows.

The compiler request is an unpacked Cap'n Proto message on stdin, bounded to 64
MiB by upstream. Each requested `path/name.capnp` produces `path/name.zig`
beneath the working directory. Generated modules import `capnpc-zig`; bind that
module to `build/src/capnp-zig/src/lib_core.zig` after `mise run build:zig`.
This serialization-only runtime includes reflection and reference-compatible
double-far struct-list writing. The build exports an exact disposable copy of
the pinned runtime alongside the generator. It applies no Zig patches and does
not modify the reference checkout. See the
[synchronization history](../../patches/capnp-zig/README.md).

The upstream command options remain available, including `--verbose`,
`--no-manifest`, `--api-profile=compact`, `--shape-sharing`, and the
`max-codegen-*=N` budget tokens. Defaults emit the full API, binary reflection
metadata, and the JSON export manifest. `--no-reflection` omits the binary
metadata and generated schema references. The generated APIs still require the
matching pinned runtime when reflection is disabled. `--no-manifest`
independently omits the JSON export manifest. The command does not invoke
another process or an external formatter. The host runs it with an empty
environment, so environment-based upstream options do not affect SDK builds.

Upstream checks every output path for traversal and symlinks. Hosts must
implement WASI `path_readlink`, including `NOENT` for a missing path and `INVAL`
for an existing path that is not a symlink. A memory filesystem without symlink
support still needs those responses; `NOTSUP` is an error.

## Generated views and validation

Ordinary Builders provide field getters, mutable struct/list reopening, typed
copy setters, field clearing, union inspection, and `asReader(&storage)`.
`capnpc.generated_helpers.ReaderStorage` borrows message buffers while owning
its segment index; keep it at a stable address and deinitialize it after use.
Any builder mutation or storage rebind invalidates borrowed Readers and slices.
Typed copies snapshot before mutation and preserve unknown stored fields,
including copies through an older primitive-list schema.

Generated Text reads require a trailing NUL and valid UTF-8, including list
elements. Low-level lenient readers remain available. Concrete generic lists and
recursive applications retain typed `brands()` views. Nested RPC result
pipelines support struct/group paths with a 64-operation bound; inherited
same-name methods gain declaring-type suffixes. Standard streaming results are
bundled with the runtime. Experimental
`Service.Apply(.{ .T = capnpc.generic.Text })` views add typed generic clients,
params/results, callbacks, server adapters, and pipelines. Method-local generic
callers use explicit `Apply` bindings; server dispatch stays erased because
those bindings are not carried on the wire. Imported superclass brands and
equivalent diamonds retain their concrete types; ambiguous ancestor applications
require an explicit `asAncestor()` view.

Generated deferred streaming handlers acknowledge after application work
completes. Delivery and subsequent barriers remain ordered. Default outbound and
retained-input windows are 64 calls and 1 MiB encoded bytes; zero disables a
selected limit. Oversized calls fail instead of temporarily exceeding a byte
window. One-shot readiness and drain callbacks expose capacity recovery and
terminal failure. These additions remain Experimental.

The [Builder/reflection tests](../../tests/reflection/README.md),
[generic API tests](../../tests/generator_api/README.md), RPC codegen tests, and
[wire conformance suite](../../tests/wire/README.md) compile and execute the new
surfaces on native Zig and WASI. Current native/Wasm output matches exactly; the
historical revision remains only a wire conformance control. These API changes
intentionally alter generated output relative to it, even under
`--no-reflection`.

## Reflection

Each generated module exposes `CAPNP_SCHEMA_REQUEST`, an unpacked binary
`CodeGeneratorRequest` containing the original schema nodes sorted by ID. The
bundle includes every node supplied by the compiler, including imported types,
annotations, constants, groups, and generic brands. It excludes requested-file
paths, source comments, and compiler version. Copying the original wire nodes
preserves fields that the pinned Zig parser does not model.

Generated structs, groups, enums, interfaces, and struct Reader/Builder types
expose `capnpSchema`, a `reflection.SchemaRef` containing their ID and bundle.
Load a registry once and reuse it for types from the same compilation request:

```zig
const capnpc = @import("capnpc-zig");
const reflection = capnpc.reflection;
const generated = @import("example.zig");

const registry = try generated.Person.capnpSchema.load(allocator);
defer registry.deinit();
const person = try (try generated.Person.capnpSchema.resolve(registry)).asStruct();
const field = try person.field("name");
const field_type = try (try field.type()).proto();
// field_type == .text

const dynamic = reflection.DynamicStruct.Reader{
    .schema = person,
    .reader = try message.getRootStruct(),
};
const name = (try dynamic.get("name")).text;
```

`Registry.get(id)` resolves any available dependency. `Schema.proto()` exposes
the parsed node, and `Schema.raw()` returns the original wire `schema::Node`.
Struct fields, enum names/ordinals, interface methods and their parameter/result
schemas are available through typed views. `Field.raw()` retains details such as
explicit ordinals and defaults; convenience methods expose those two values.
Annotations and constant values are available on the parsed nodes. A referenced
ID absent from the compiler request produces `SchemaNotFound` when resolved.

Type views resolve generic parameters through the declaring field's brand. Keep
that context by following `Field.type().asStruct()` or `listElement()`; looking
up the generic declaration directly by ID gives its unbound form.

`DynamicStruct.Reader.get(name)` returns a tagged `Value`. Scalars use their
declared width, pointer fields apply schema defaults, and enum values retain
unknown ordinals. `which()` identifies the active union field. `has()` follows
C++'s non-null presence rules; `hasNonDefault()` also checks scalar wire bits.
Inactive union fields are absent and `get()` reports `InactiveUnionField`.

`DynamicStruct.Builder.init(schema, &builder)` allocates a root. `set()` checks
value types and generic bindings, applies XOR defaults, and selects union arms.
`initStruct()`, `initGroup()`, and `initList()` allocate field values;
`getStruct()` and `getList()` reopen them, copying pointer defaults before
mutation. `clear()` restores a field's default. Dynamic lists provide indexed
access for scalar, enum, struct, pointer, and nested-list elements. Text writes
validate UTF-8, and constrained AnyPointer fields validate pointer shape.

Ordinary struct copies preserve unknown fields. Reopening a smaller struct with
a newer schema expands it while preserving existing contents. Struct lists also
widen automatically when accessing fields from a newer schema or assigning an
element with a larger physical layout. Existing elements and unknown fields
survive the replacement. Byte, integer, pointer, and void lists can evolve into
struct lists according to the reference rules; packed Boolean lists report
`TypeMismatch`.

A dynamic list handle continues to resolve its current storage after widening.
Previously acquired element and nested builders refer to the old storage and
must be reacquired through that list. Reading its length or using an invalid
index does not change the list. If allocation or copying fails during widening,
the original list remains reachable; temporary allocations are reclaimed when
the message builder is destroyed.

Interface values expose optional wire capability indices; `null` remains
distinct from index zero. This API provides interface metadata and data
reflection, but does not add dynamic RPC dispatch or a JSON codec.

Registries own a copy of the descriptor bytes and their parsed graph. Schema
views borrow the registry; dynamic views also borrow the message they read or
build. Keep both owners alive. Registry copies are borrowed handles, so call
`deinit()` exactly once. Pointer defaults are cached in stable registry-owned
messages and must be cloned before modification. Sharing a registry between
threads requires synchronization around its lazy default cache. Explicit brands
passed to `Schema.asStructWithBrand()` also borrow their caller-supplied binding
slices; keep those bindings alive with the views.

`Registry.initWithOptions` and `SchemaRef.loadWithOptions` bound input bytes (64
MiB), live registry allocation (128 MiB), node count (65,536), and wire
validation work. Defaults use the same limits. The memory budget includes lazy
default materialization; actual allocator failure remains `OutOfMemory`.

Dynamic Builders provide scalar/presence/union queries and `asReader(&storage)`.
Rebind storage after mutation, and reacquire list element builders after growth.
Copies preserve reachable values and union selection on failure, including
self-copy and overlapping views. Their `copy_options` bound expanded graph work,
output words, additional live backing allocation, and nesting. Defaults are
8,388,608 work units/output words, 64 MiB, and 64 levels. Shared targets are
charged per incoming pointer, including logical zero-width list elements.

Wire copying preserves numeric capability indices without transferring RPC
ownership. Use the explicit capability-table remapper or peer proxy-copy path
for copies between distinct tables; those paths own mapping/pinning/release
effects separately. The independent C++ mutation corpus and native/WASI failure
sweeps cover the runtime used here.

## Native synchronization

The `ref/capnp-zig` gitlink recorded by this repository is the only source of
truth. [`sync.json`](sync.json) maps each native conformance fixture to its
mirror under `tests/`; it records no hashes. `mise run check:zig-sync` (also
part of every `build:zig`) reads the committed tree at the gitlink and fails
when the prepared `build/src/capnp-zig/src` has missing, extra, or changed
files, when a mirrored fixture differs from its native file, or when the
historical export differs from `historical-reference`. A hand-edited mirror
therefore fails even if the manifest is edited too. After advancing the
reference, refresh the mirrors from the gitlink and review the diff before
committing:

```sh
mise exec -- deno run --allow-read --allow-write=tests --allow-run=git \
  scripts/check-zig-sync.ts --update-fixtures
```

There is no local Zig patch layer. `historical-reference` separately pins the
old audit revision. `mise run refs:sync` fetches that commit even in a shallow
checkout; `build:zig` exports it under `build/src/capnp-zig-historical`. The
wire tests retain their original failing-writer and validation controls there.

The JSON manifest remains a separate list of module/type/export names. It is not
used to implement reflection. Binary descriptors increase generated source size;
`--no-reflection` is available when an application needs only typed
serialization. Programmatic `Generator` users supply the original request with
`try setSchemaRequest(bytes)` to enable lossless reflection emission. This
fallible setup method owns the encoded metadata, so the caller can release the
original request immediately after it returns. Encoding failures preserve any
previously configured metadata.
