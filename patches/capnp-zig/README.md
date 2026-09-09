# Zig compatibility patches

The pinned upstream generator builds directly for WASI with the pinned Zig
toolchain. `scripts/build-zig.sh` exports committed sources under
`build/src/capnp-zig` and applies the patches in filename order to both native
and Wasm commands. The reference checkout remains pristine.

`0001-resolve-workspace-imports.patch` corrects generated imports for nested
schema workspaces. Upstream applies output-path validation to import names,
rejecting a valid `../shared/common.capnp` import from `nested/brands.capnp`. It
also removes the leading slash from root-relative imports without adjusting for
the importing file's directory.

The correction resolves imports against the requesting schema's directory (or
the workspace root for `/` imports), rejects traversal outside that root, and
emits a relative `.zig` import from the generated file. Output filenames retain
their strict validation. This patch alone leaves generated code for the basic
and values fixtures byte-identical to the unmodified upstream command. Later
patches add reflection and generated APIs as described below.

`0002-qualify-brand-views.patch` qualifies the return type of the Reader and
Builder `brands()` methods as `@This().Brands`. A schema struct named `Brands`
otherwise makes the generated return type ambiguous between that struct and the
nested typed view. The brands consumer compiles the generated result and
roundtrips bound generic fields to exercise this correction.

`0003-qualify-helper-views.patch` fixes the corresponding collisions for schema
types named `WhichTag`, `EnumOrdinals`, `NestedLists`, and `PointerKinds`.
Reader and Builder helper-view return types use `@This()` qualification when a
same-named schema declaration is visible. Union tags and schema type references
shadowed by an emitted helper use the existing `_capnp_file` namespace anchor;
this also disambiguates nested enum types such as `EnumOrdinals.State`. Group
accessors use the same resolver when a group name collides with its parent's
helper view. Imported module paths retain their original spelling. Schemas
without these collisions retain their upstream output through this patch,
including the basic and values corpus.

The shared `helper-names` scenario compiles and runs both C++ and Zig consumers.
Its Zig consumer uses both Reader and Builder views, union selection and guards,
known and unknown enum ordinals, nested UInt32 lists, and constrained AnyStruct
allocation and reads. All generated source bytes and the complete canonical
request are compared across native and Wasm hosts. These compile-and-use tests
catch failures that generator byte parity alone cannot detect. The existing
Reader/Builder schema-name collisions remain outside this patch.

`0004-standardize-double-far-lists.patch` corrects the runtime's public
`writeStructListInSegments` path when landing and content segments differ. The
landing pad now contains a far pointer to an in-content element tag and a
zero-offset LIST pointer whose word count excludes that tag. This matches the
reference encoding. Previously the writer put the element tag in the landing pad
(Layout A), which Zig accepted but C++ rejected. Same-segment and single-far
list encoding remains unchanged, and the reader retains legacy Layout A
compatibility. Patch 0007 below addresses Text strictness and double-far struct
validation.

The [wire conformance suite](../../tests/wire/README.md) exercises both the
pristine and patched runtime and cross-checks emitted messages with the C++
reader. Run `mise run build:zig` and bind the `capnpc-zig` module to
`build/src/capnp-zig/src/lib_core.zig` for the writer correction and reflection.
That source copy is disposable and recreated from the pin, these patches, and
the project-owned reflection sources. Never edit `ref/` to make runtime changes.

`0005-embed-reflection-metadata.patch` preserves the compiler's original binary
schema nodes in a canonical, ID-sorted `CAPNP_SCHEMA_REQUEST` bundle. Each
generated struct, group, enum, and interface carries its own `capnpSchema`
reference. The metadata preserves defaults, annotations, imports, brands, and
unknown node fields. `--no-reflection` independently restores metadata-free
output; the existing JSON manifest options keep their original meaning.

`0006-export-reflection-runtime.patch` exports `reflection` from all three
runtime roots. The implementation lives in
[`generators/zig/runtime`](../../generators/zig/runtime/) and is copied into the
disposable source tree by the build script. Source hashes participate in the
build key. The registry and dynamic views reuse the pinned request parser, type
resolver, and message runtime. See the
[reflection API](../../generators/zig/README.md#reflection) and
[conformance tests](../../tests/reflection/README.md).

`0007-complete-generated-views.patch` synchronizes the native capnp-zig source
at commit `68ad72f`, including Builder, generic, RPC, and validation
improvements. Ordinary Builders gain getters, mutable pointer reopening, typed
copying, field clearing, union inspection, and an explicit-storage `asReader`.
Concrete generic list and recursive applications retain typed `brands()` views.
Nested result pipelines carry bounded transform paths, inherited method
collisions use declaring-type suffixes, and the standard streaming result is
bundled. Generated Text reads require a trailing NUL and valid UTF-8, including
list elements.

The runtime validates pointer sections below canonical double-far structs and
charges zero-width composite lists against the traversal budget. Mutable
primitive and pointer list views accept evolved composite lists with their
original stride. Unknown struct sections survive reopening and typed copies.
Validation runs when initializing or explicitly validating a message; repeated
reader access does not consume a separate per-read budget. A zero-count legacy
Layout A tag is ambiguous with a canonical struct tag and now receives canonical
struct bounds and traversal checks. Nonempty legacy list reads remain supported.

This patch includes matching checked-in RPC/Wasm bindings and the new source
helpers. It intentionally changes generated source even with `--no-reflection`.
The pristine binary remains a historical oracle; output parity against that old
revision is no longer an acceptance criterion for Zig. Patched native and Wasm
generators must match byte for byte, with generated-code consumers and C++ wire
checks providing independent behavioral evidence. Other languages retain their
pristine generator comparisons.

The import patch includes focused resolution and traversal tests. After
`mise run build:zig`, run them with:

```sh
mise exec -- zig test build/src/capnp-zig/src/main.zig \
  --cache-dir build/zig/cache --test-filter 'main tests' \
  --test-filter Generator.importPath
```

The shared brands corpus tests the parent-relative import through the real
compiler and hosts. The native `capnpc-zig-upstream` binary remains available to
reproduce historical behavior and compare explicitly unchanged wire paths.
