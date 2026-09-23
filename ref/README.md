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
| [capnp-zig](https://github.com/nullstyle/capnp-zig)              | Zig generator and matching runtime, built pristine for native and WASI hosts               | `src/capnpc-zig/`, `src/lib_core.zig`, `mise.toml`, `build.zig.zon`    |
| [wazero](https://github.com/wazero/wazero)                       | Go host runtime, WASI implementation, and filesystem behavior                              | `imports/wasi_snapshot_preview1/example/`, `config.go`                 |
| [browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim) | The TypeScript SDK's WASI implementation and in-memory filesystem                          | `src/wasi.ts`, `src/fs_mem.ts`, `examples/`, `README.md`               |
| [wasi-sdk](https://github.com/WebAssembly/wasi-sdk)              | Cross-toolchain documentation and CMake configuration, pinned to the installed SDK release | `README.md`, `cmake/`, `tests/`                                        |
| [WASI](https://github.com/WebAssembly/WASI/tree/wasi-0.1)        | Preview 1 definitions and ABI semantics, pinned from the `wasi-0.1` branch                 | `preview1/`, `application-abi.md`                                      |

The TypeScript SDK imports the browser shim's source directly
(`sdk/typescript/runtime.ts`) and adapts two behaviors at runtime without
modifying the reference: `path_readlink` answers `NOENT` and `INVAL` instead of
`NOTSUP`, and `args_get` sizing counts UTF-8 bytes. The browser and Deno suites
verify that combination in Chromium, Firefox, WebKit, and Deno; the shim alone
does not establish support for any other engine. Wazero's GitHub location
differs from its Go module path; follow its `go.mod` when adding a module
dependency.

`ref/capnp-zig` is checked out at the pinned generator revision.
`generators/zig/historical-reference` additionally names the older audited
revision that `mise run refs:sync` fetches into the same checkout; the wire
conformance suite exports it as an oracle. Bumping any reference follows the
checklist in [CONTRIBUTING.md](../CONTRIBUTING.md).

Keep upstream checkouts pristine. Store project patches and wrappers outside
`ref/` and build in disposable directories under `build/`. Initialize a nested
submodule only when a concrete build or investigation requires it.
