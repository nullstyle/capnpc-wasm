/** Shared native/SDK fixture; no source text or import names are rewritten. */
export const compilerPathFixture = {
  files: {
    "workspace/app/person.capnp":
      '@0xece4bf9c1f867623; using Common = import "/common.capnp"; using Parent = import "../parent.capnp"; struct Person { selected @0 :Common.Value; parent @1 :Parent.Value; bytes @2 :Data = embed "../bytes.bin"; }',
    "workspace/parent.capnp":
      "@0x9c9e5ec72c9f6a21; struct Value { label @0 :Text; }",
    "workspace/bytes.bin": new Uint8Array([0, 128, 255, 42]),
    "outside.capnp": "@0xe730e9b7daf07b13; struct Outside { value @0 :Bool; }",
    "roots/first/common.capnp":
      "@0xb4bbd4e34c6f77f1; struct Value { first @0 :UInt32; }",
    "roots/second/common.capnp":
      "@0xdbca7fc6b19b98a3; struct Value { second @0 :UInt64; }",
  },
  entrypoints: ["workspace/app/person.capnp", "outside.capnp"],
  importPaths: ["roots/first", "roots/second"],
  sourcePrefix: "workspace",
  generators: [] as [],
};
