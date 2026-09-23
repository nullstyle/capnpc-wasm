# Generated generic API consumers

These four schemas and five Zig consumers mirror the native package's
`tests/test_schemas/generic_*.capnp` and
`tests/serialization/support/generic_*_consumer.zig` regression fixtures.
`cases.json` maps each consumer to its schema; the evolution case deliberately
reuses the collection schema with an older wire layout.

Consumers use generated public APIs and `std.testing`. They cover direct
`List(Box(Text))`, recursive `Link(Text)` including recursive lists, alternating
concrete Text/Data bindings, list layout growth with unknown data, pointer
defaults, and union guards. No fixture uses the compiler-unsupported `List(T)`.

`tests/generator_api_test.ts` runs the gate for both the full and compact API
profiles. For each schema it compiles a request with the native compiler, runs
the native and WASI generators, requires byte-identical output, and places the
generated module beside each consumer as `generated.zig`. It then compiles every
consumer with `zig test` against the exported pinned runtime
(`build/src/capnp-zig/src/lib_core.zig`), natively and as a `wasm32-wasi` test
executable that runs in Wasmtime. Outputs stay under
`build/test/generator-api-*/`.

Run through `mise run test`, or after `mise run build`:

```sh
mise exec -- deno test --allow-read --allow-write=build --allow-run tests/generator_api_test.ts
```
