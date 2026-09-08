# Rust, Go, and Zig generators

`mise run build:rust`, `mise run build:go`, and `mise run build:zig` build
native reference commands under `build/native/bin/` and WASI Preview 1 commands
under `build/wasm/bin/`. All are also part of `mise run build` and
`mise run test`.

Each generator reads an unpacked `CodeGeneratorRequest` from stdin and writes
source files beneath its working directory. The host stages a fresh output
directory and publishes files only after a successful exit. Generators do not
invoke the compiler or external formatters.

## Rust

`rust/` is a small command wrapper around the pinned upstream
`capnpc::codegen::CodeGenerationCommand`. Cargo path dependencies select
`ref/capnproto-rust`; `Cargo.lock` locks the remaining graph. Native and Wasm
builds use the same source and lockfile.

`capnpc-rust` accepts `--output-directory PATH` (default `.`), `--help`, and
`--version`. Its version identifies the project wrapper; the upstream generator
revision is the Git submodule entry. The wrapper calls the code-generation API
directly without `CompilerCommand` or `rustfmt`.

## Go

`go/` records the upstream generator as a Go tool dependency and uses a local
module replacement for `ref/go-capnp`. The build compiles the upstream
`capnpc-go` main package directly with `CGO_ENABLED=0`, changing only
`GOOS=wasip1 GOARCH=wasm` for the Wasm command. Formatting runs in process
through upstream `go/format`.

Schemas need the upstream `$Go.package` and `$Go.import` annotations. Stage
`ref/go-capnp/std/go.capnp` on the compiler's include path; the fixture schemas
show package and import paths for multiple generated packages. Upstream options
such as `-promises`, `-schemas`, and `-structstrings` remain available.

The Go standard WASI runtime retains `sock_accept` and `sock_shutdown` imports
even though the generator does not use networking. Artifact checks allow those
two imports only for this command; the development hosts grant no socket file
descriptors.

## Zig

The [Zig command](zig/README.md) builds the existing `capnp-zig` generator for
native and WASI hosts with the exact upstream Zig pin. Generated `name.zig`
files import the `capnpc-zig` module. Bind that name to the pinned library;
serialization consumers use its `src/lib_core.zig` entry point. No language
annotations are required. The SDK uses the upstream full API and schema manifest
defaults.

## Verification

`tests/toolchain_test.ts` compares native and Wasm generation from both native
and Wasm compiler requests in Wasmtime, wazero's compiler and interpreter, and
Deno with the browser WASI shim. Rust, Go, and Zig output must match the native
generator byte for byte. Malformed requests must fail without output files.

The consumer fixtures under `tests/consumers/` compile Wasm-generated source
against the pinned runtimes and roundtrip a message containing a large `UInt64`,
Unicode text, a nested list, defaults, and a union. Generated source and
disposable Go consumer modules remain under `build/test/`; Rust build output
uses the root `CARGO_TARGET_DIR`.
