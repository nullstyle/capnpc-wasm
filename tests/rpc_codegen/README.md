# Generated RPC API consumers

These schemas and consumers mirror the native package's compiler-driven RPC
regressions. The test compiles actual requests using only the package's standard
schema include tree, compares every generated file byte for byte between native
and WASI commands, then runs the generated public APIs natively and in WASI.
Both full and compact API profiles participate.

- Nested capability pipelines assert exact wire pointer transforms through
  structs, groups, and recursive structs, plus the 64-operation bound and
  omitted union arms. Existing direct capability getters retain their signature.
- Same-name inherited methods assert declaring interface IDs and method
  ordinals, qualified client and server access, diamond inheritance, imported
  same-name interfaces, and deterministic ID suffixes when qualified names or
  their generated `WithOptions` companions collide. A pair of detached peers
  dispatches both methods and verifies their distinct results.
- Streaming compiles against the bundled `capnp/stream.capnp` and uses the
  bundled reflected `StreamResult` binding. Detached peers verify streaming
  delivery and acknowledgement without generating another standard schema
  module.

The detached peers exercise RPC encoding and dispatch without opening sockets.
These cases do not establish support for generic RPC specialization or
capability pipelines through a type parameter.
