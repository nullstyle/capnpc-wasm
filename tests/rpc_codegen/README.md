# Generated RPC API consumers

These schemas and consumers mirror the native package's compiler-driven RPC
regressions. `tests/rpc_codegen_test.ts` compiles actual requests using only the
package's standard schema include tree, compares every generated file byte for
byte between the native and WASI commands, then compiles each consumer with
`zig test` against the exported pinned runtime
(`build/src/capnp-zig/src/lib.zig`) and runs it natively and as a `wasm32-wasi`
test executable in Wasmtime. Both the full and compact API profiles participate.
Four cases run:

- `pipeline`: nested capability pipelines assert exact wire pointer transforms
  through structs, groups, and recursive structs, plus the 64-operation bound
  and omitted union arms. Existing direct capability getters retain their
  signature.
- `inherited`: same-name inherited methods assert declaring interface IDs and
  method ordinals, qualified client and server access, diamond inheritance,
  imported same-name interfaces, and deterministic ID suffixes when qualified
  names or their generated `WithOptions` companions collide. A pair of detached
  peers dispatches both methods and verifies their distinct results.
- `streaming`: compiles against the bundled `capnp/stream.capnp` and uses the
  bundled reflected `StreamResult` binding. Detached peers verify streaming
  delivery and acknowledgement without generating another standard schema
  module.
- `generic`: `generic_rpc.capnp` with `generic_rpc_external.capnp` applies one
  generic interface to two bindings in one program
  (`Service.Apply(.{ .T = capnp.generic.Text })` and the `Data` counterpart)
  with typed parameters, results, callbacks, and server adapters. Its tests also
  cover method-local generics with ordinary erased server dispatch, generic
  capability pipelines that keep recursive applications before the parent reply,
  imported superclass bindings across multiple ancestors and equivalent
  diamonds, conflicting ancestor bindings that require an explicit
  `asAncestor()` view, named method-local parameter and result structs,
  constrained pointer setters that preserve the destination on rejection, and
  pipelines that compose struct and capability applications.

The detached peers exercise RPC encoding and dispatch without opening sockets.
Server dispatch for generic methods stays erased because bindings are not
carried on the wire; the typed views are a client-side and adapter-side
contract. Outputs stay under `build/test/rpc-codegen-*/`.

Run `mise run test:rpc-codegen`; it is part of `mise run test` and builds the
native tools and Zig commands it needs.
