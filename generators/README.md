# Rust, Go, and Zig generators

`mise run build:rust`, `mise run build:go`, and `mise run build:zig` build
native reference commands under `build/native/bin/` and WASI Preview 1 commands
under `build/wasm/bin/`. All are also part of `mise run build` and
`mise run test`.

Each generator reads an unpacked `CodeGeneratorRequest` from stdin and writes
source files beneath its working directory. The host stages a fresh output
directory and publishes files only after a successful exit. Generators do not
invoke the compiler or external formatters.

The TypeScript and Go SDKs always run each generator with its default options:
the guest `argv` holds only the command name. Options such as `--no-reflection`,
`--api-profile=compact`, or Go's `-promises` are reachable only through a
command host such as the packaged launcher, Wasmtime, or the development runners
under `tests/hosts/`.

## Generated code runtime requirements

Generated source compiles only against the runtime revision that matches the
pinned generator. The pins are the Git submodule entries under `ref/`; only
capnproto-rust sits on an upstream release tag.

| Generator     | Runtime the output needs                                                                                                                                                                                                | How to consume it                                                                                                                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `capnpc-c++`  | Cap'n Proto v2 at `851c45bb39c34c3f20f9d9ebe9f34a7e39109b6f` (branch `v2`, reported as `2.0-dev`, `CAPNP_VERSION` 2000000). Generated headers `#error` against any other `CAPNP_VERSION`, including every released 1.x  | Build the C++ runtime from that commit of `ref/capnproto`; there is no matching upstream release                                                                                                                                                                   |
| `capnpc-rust` | `capnp` 0.27.2 and `capnpc` 0.27.0 at `81bc1b815d0f450c9114f9cc2e2274182d210df2` (tag `capnp-v0.27.2`)                                                                                                                  | Pin `capnp = "=0.27.2"`; the tests use a path dependency on `ref/capnproto-rust`, and a git dependency at that revision is equivalent                                                                                                                              |
| `capnpc-go`   | go-capnp at `5d74edb9db427bb8776c7da5d14c6dba314eb156` (`v3.1.0-alpha.2-124-g5d74edb`, untagged)                                                                                                                        | `go get capnproto.org/go/capnp/v3@v3.1.0-alpha.2.0.20260727122444-5d74edb9db42`, or a `replace` directive to a checkout as `tests/consumers/go/go.mod` does; schemas need `$Go.package` and `$Go.import` from `ref/go-capnp/std/go.capnp`                          |
| `capnpc-zig`  | capnp-zig at `0fb8df40126ea166f95016963c465b03db22819e` (`v0.18.0-14-g0fb8df4`, untagged; `build.zig.zon` package `capnpc_zig` 0.18.0, minimum Zig 0.17.0-dev.1683; this repository pins Zig 0.17.0-dev.1683+5ceec001b) | Bind the `capnpc-zig` module to `src/lib_core.zig` of that commit; `mise run build:zig` exports it to `build/src/capnp-zig/src/lib_core.zig`. A consumer outside this repository adds that commit of `nullstyle/capnp-zig` as a `build.zig.zon` dependency instead |

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
such as `-promises`, `-schemas`, and `-structstrings` remain available to
command hosts.

The Go standard WASI runtime retains `sock_accept` and `sock_shutdown` imports
even though the generator does not use networking. Artifact checks allow those
two imports only for this command; the development hosts grant no socket file
descriptors.

## Zig

The [Zig command](zig/README.md) builds the pinned `capnp-zig` generator for
native and WASI hosts with the exact upstream Zig pin. Generated `name.zig`
files import the `capnpc-zig` module. Bind that name to
`build/src/capnp-zig/src/lib_core.zig`, the pinned runtime exported without
modification, which includes [reflection support](zig/README.md#reflection).
Generated binary nodes support schema lookup and dynamic message access;
`--no-reflection` omits that metadata while retaining the typed APIs and their
dependency on the matching pinned runtime. No language annotations are required.
The generator's defaults emit the full API, binary reflection metadata, and the
JSON export manifest, and the SDKs always use those defaults.

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
