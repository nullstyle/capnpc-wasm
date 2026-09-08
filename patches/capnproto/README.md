# Cap'n Proto WASI command port

`0001-wasi-command-tools.patch` applies to Cap'n Proto revision
`851c45bb39c34c3f20f9d9ebe9f34a7e39109b6f`. Apply it to a disposable copy of the
upstream repository, never to `ref/capnproto`.

The patch adapts the synchronous compiler and C++ generators to WASI Preview 1:

- `capnp compile -o-` emits the standard, unpacked `CodeGeneratorRequest` on
  stdout. Generator process launch is rejected with a diagnostic and nonzero
  exit; the host runs each generator with that request on stdin.
- Schema IDs and temporary filename identifiers use WASI `random_get`.
- Read-only and private file mappings read into owned byte arrays. Inputs must
  remain immutable during each command. Writable file mappings are explicitly
  unsupported; the compiler and generators do not require them.
- WASI uses the existing wasm32 reader arena padding. Native signal handlers and
  instruction return addresses are unavailable; exception diagnostics retain
  their source locations, while the host handles Wasm traps.
- Creating regular file placeholders uses the existing `openat` fallback.

`cmake/CMakeLists.txt` selects only the synchronous libraries these commands
need. It produces `capnp.wasm`, `capnpc-c++.wasm`, and `capnpc-capnp.wasm` using
WASI SDK 34's `wasi-sdk-p1.cmake` toolchain. Set `CAPNP_SOURCE_DIR` to the
patched upstream root and optionally `CMAKE_RUNTIME_OUTPUT_DIRECTORY` to the
output directory. The compiler's built-in schema include directory is
`/include`. Hosts should stage schemas there or pass `--no-standard-import` and
explicit `-I` paths.

The modules are single threaded and preserve upstream C++ exception handling.
They require standardized WebAssembly exception handling, compiled with
`-fwasm-exceptions -mllvm -wasm-use-legacy-eh=false` and linked with
`-fwasm-exceptions -lunwind`. LTO is disabled because SDK 34 documents a known
exception handling issue with it. Wasmtime requires `-W exceptions=y`; other
hosts must enable or support the same standardized exception instructions.

Validate the feature boundary explicitly, for example:

```sh
mise exec -- wasm-tools validate \
  --features=-legacy-exceptions,-threads,-shared-everything-threads,-memory64 \
  build/wasm/bin/capnp.wasm
```

Apply the same check to both generator modules. The build reads the CLI version
string from the pinned upstream CMake configuration for all three commands.

Each command needs an isolated guest filesystem exposed at `/`, with stdin,
stdout, and stderr connected. Filesystem permissions, output capture, resource
limits, and publication of successful output belong to the host. This port is
not a general WASI port of KJ's threading, asynchronous I/O, or RPC libraries.
