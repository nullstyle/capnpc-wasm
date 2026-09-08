# Zig generator

`mise run build:zig` compiles the pinned `ref/capnp-zig/src/main.zig` directly
for the native host and `wasm32-wasi` (Zig's name for WASI Preview 1). The
artifacts are `build/native/bin/capnpc-zig` and
`build/wasm/bin/capnpc-zig.wasm`. Both use the upstream request reader,
validator, and generator, with the same
[compatibility corrections](../../patches/capnp-zig/README.md) applied to a
disposable source copy. The build also emits an unmodified native oracle at
`build/native/bin/capnpc-zig-upstream`. There is no second emitter or RPC
transport dependency.

The compiler request is an unpacked Cap'n Proto message on stdin, bounded to 64
MiB by upstream. Each requested `path/name.capnp` produces `path/name.zig`
beneath the working directory. Generated modules import `capnpc-zig`; bind that
module to the matching pinned runtime. Serialization-only consumers can use
`ref/capnp-zig/src/lib_core.zig`.

The upstream command options remain available, including `--verbose`,
`--no-manifest`, `--api-profile=compact`, `--shape-sharing`, and the
`max-codegen-*=N` budget tokens. Defaults emit the full API and schema manifest.
The command does not invoke another process or an external formatter. The host
runs it with an empty environment, so environment-based upstream options do not
affect SDK builds.

Upstream checks every output path for traversal and symlinks. Hosts must
implement WASI `path_readlink`, including `NOENT` for a missing path and `INVAL`
for an existing path that is not a symlink. A memory filesystem without symlink
support still needs those responses; `NOTSUP` is an error.
