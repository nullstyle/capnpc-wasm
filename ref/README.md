# Upstream references

These checkouts provide source, schemas, examples, and specifications for
porting. The parent repository's gitlinks pin their revisions; use
`mise run refs:status` to inspect them. Run project commands from the repository
root.

| Directory / upstream                                             | Why it is here                                                                             | Start reading at                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| [capnproto](https://github.com/capnproto/capnproto)              | Authoritative compiler, C++ generator, KJ support, and standard schemas                    | `c++/src/capnp/compiler/`, `c++/src/kj/`, `c++/src/capnp/schema.capnp` |
| [capnproto-rust](https://github.com/capnproto/capnproto-rust)    | Rust generator API, runtime, and output examples                                           | `capnpc/src/codegen.rs`, `capnpc/src/lib.rs`, `capnp/`                 |
| [go-capnp](https://github.com/capnproto/go-capnp)                | Go generator, runtime, and annotation schemas                                              | `capnpc-go/`, `std/`, `go.mod`                                         |
| [capnp-zig](https://github.com/nullstyle/capnp-zig)              | Existing Zig generator and matching runtime                                                | `src/capnpc-zig/`, `mise.toml`, `build.zig`                            |
| [wazero](https://github.com/wazero/wazero)                       | Go host runtime, WASI implementation, and filesystem behavior                              | `imports/wasi_snapshot_preview1/example/`, `config.go`                 |
| [browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim) | Candidate TypeScript WASI implementation and in-memory filesystem                          | `src/`, `examples/`, `README.md`                                       |
| [wasi-sdk](https://github.com/WebAssembly/wasi-sdk)              | Cross-toolchain documentation and CMake configuration, pinned to the installed SDK release | `README.md`, `cmake/`, `tests/`                                        |
| [WASI](https://github.com/WebAssembly/WASI/tree/wasi-0.1)        | Preview 1 definitions and ABI semantics, pinned from the `wasi-0.1` branch                 | `preview1/`, `application-abi.md`                                      |

The browser shim is a candidate with incomplete WASI support; having it here
does not establish host compatibility. Wazero's GitHub location differs from its
Go module path; follow its `go.mod` when adding a module dependency.

Keep upstream checkouts pristine. Store project patches and wrappers outside
`ref/` and build in disposable directories under `build/`. Initialize a nested
submodule only when a concrete build or investigation requires it.
