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

Both scenarios generate with the pinned native and Wasm C++, Rust, Go, and Zig
generators. Go represents generic parameters as dynamic pointers in its upstream
API; the test compares that actual upstream output. No generator is skipped.

Each host compares the complete canonical binary `CodeGeneratorRequest` and
every generated source byte against fresh native output. The TypeScript test
also compiles its generated C++ and Zig and runs consumers in `consumers/` and
`tests/consumers/zig/`, checking defaults and serialization roundtrips against
the pinned native runtimes. The binary fixture `workspace/assets/bytes.bin` is
exactly the byte sequence 0–255; it is read as bytes throughout, without text
decoding.

Run through `mise run test`, or after building:

```sh
mise exec -- deno test --config sdk/typescript/deno.json --unstable-sloppy-imports --allow-read --allow-write=build --allow-run tests/schema_features_test.ts
mise exec -- go -C sdk/go test -run TestSchemaFeatures ./...
```
