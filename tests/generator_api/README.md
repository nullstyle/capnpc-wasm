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

The host gate should compile actual compiler requests, compare native and WASI
generator output in full and compact profiles, place the selected generated
module beside each consumer as `generated.zig`, and compile/run that same
consumer natively and as a WASI test executable. The runtime must match the
patched generator and export its normal `capnpc-zig` self-import binding.
