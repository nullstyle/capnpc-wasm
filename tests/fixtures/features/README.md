# Schema feature corpus

`manifest.json` names workspace files and independently compiled scenarios. The
same files feed the TypeScript SDK test (`tests/schema_features_test.ts`), the
Go SDK test (`sdk/go/feature_test.go`), and the browser suite
(`tests/browser/test.ts`). Standard C++ and Go annotations are supplied from
their pinned references as include files.

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
  helpers in the originally audited capnp-zig revision (finding 1 of the
  [compatibility audit](../../../docs/history/capnp-zig-compatibility-audit.md));
  the pinned generator qualifies its helper views. The scenario also
  distinguishes an `enumOrdinals` group from the parent's generated enum ordinal
  view.

All scenarios generate with the pinned native and Wasm C++, Rust, Go, and Zig
generators. Go represents generic parameters as dynamic pointers in its upstream
API; the test compares that actual upstream output. No generator is skipped.

Each host compares the complete canonical binary `CodeGeneratorRequest` and
every generated source byte against fresh output from the same pinned generators
built natively. The TypeScript test also compiles its generated C++ and Zig and
runs consumers in `consumers/` and `tests/consumers/zig/`, checking defaults,
generated helper APIs, and serialization roundtrips against the pinned native
runtimes. The binary fixture `workspace/assets/bytes.bin` is exactly the byte
sequence 0–255; it is read as bytes throughout, without text decoding.

The oracle is the pinned generator itself. No test compares Zig output with the
historical pristine generator: the pinned capnp-zig generator intentionally
emits additional typed APIs, so byte identity with that older revision is not a
contract. The historical revision remains an oracle only in the
[wire conformance suite](../../wire/README.md).

Run `mise run test:features` for the TypeScript side and `mise run test:sdk-go`
for the Go side; both are part of `mise run test` and build what they need. To
run only the Go corpus test after building:

```sh
mise exec -- go -C sdk/go test -count=1 -mod=readonly -run TestSchemaFeatures ./...
```
