# Zig generator patches

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
