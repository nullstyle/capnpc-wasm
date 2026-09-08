# Schema feature corpus

`manifest.json` names workspace files and independently compiled scenarios. The
same files feed the public TypeScript and Go SDK tests. Standard C++ and Go
annotations are supplied from their pinned references as include files.

- `values` covers binary and Unicode text embeds, Data and Text defaults
  (including embedded NUL), all 256 byte values, signed and unsigned 64-bit
  extremes, list and struct defaults, groups, a union containing a group, nested
  enums, custom annotations, and imported constants.
- `brands` covers a legitimate `../shared/common.capnp` import inside the
  workspace, nested generic parameters, bound and unbound brands, aliases,
  AnyPointer, AnyStruct, AnyList, and typed pointer constants and defaults.
- `helper-names` covers legal schema structs named `WhichTag`, `EnumOrdinals`,
  `NestedLists`, and `PointerKinds`. Its Zig consumer exercises union
  discriminants and guards, Reader and Builder enum ordinal views (including an
  unknown ordinal), typed nested UInt32 lists, and constrained AnyStruct
  initialization, reopening, and reading. These names collided with generated
  helpers before the third Zig compatibility patch. It also distinguishes an
  `enumOrdinals` group from the parent's generated enum ordinal view.

All scenarios generate with the pinned native and Wasm C++, Rust, Go, and Zig
generators. Go represents generic parameters as dynamic pointers in its upstream
API; the test compares that actual upstream output. No generator is skipped.

Each host compares the complete canonical binary `CodeGeneratorRequest` and
every generated source byte against fresh native output. The TypeScript test
also compiles its generated C++ and Zig and runs consumers in `consumers/` and
`tests/consumers/zig/`, checking defaults, generated helper APIs, and
serialization roundtrips against the pinned native runtimes. The binary fixture
`workspace/assets/bytes.bin` is exactly the byte sequence 0–255; it is read as
bytes throughout, without text decoding.

The TypeScript test also compares `values` byte for byte with the pristine Zig
generator. For `helper-names`, it permits only patch 0003's exact helper-view
return qualifications, qualified group accessors, file-qualified union and
nested enum references, and their file namespace alias; expected occurrence
counts guard these substitutions.

Run through `mise run test`, or after building:

```sh
mise exec -- deno test --config sdk/typescript/deno.json --unstable-sloppy-imports --allow-read --allow-write=build --allow-run tests/schema_features_test.ts
mise exec -- go -C sdk/go test -count=1 -mod=readonly -run TestSchemaFeatures ./...
```
