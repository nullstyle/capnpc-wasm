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
their strict validation. Generated code for the existing basic and values
fixtures remains byte-identical to the unmodified upstream command.

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
without these collisions retain their upstream output, including the basic and
values corpus.

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
compatibility. Text strictness and double-far struct validation are separate
open findings.

The [wire conformance suite](../../tests/wire/README.md) exercises both the
pristine and patched runtime and cross-checks emitted messages with the C++
reader. Generator consumers can still use the pristine pinned runtime; to use
the writer correction, run `mise run build:zig` and bind the `capnpc-zig` module
to `build/src/capnp-zig/src/lib_core.zig`. That source copy is disposable and
recreated from the pin plus these patches; runtime changes belong in patch
files, never in `ref/`.

The import patch includes focused resolution and traversal tests. After
`mise run build:zig`, run them with:

```sh
mise exec -- zig test build/src/capnp-zig/src/main.zig \
  --cache-dir build/zig/cache --test-filter 'main tests' \
  --test-filter Generator.importPath
```

The shared brands corpus tests the parent-relative import through the real
compiler and hosts. The native `capnpc-zig-upstream` binary remains available to
detect unintended output changes on schemas supported without the patch.
