# Architecture

capnpc-wasm runs the upstream Cap'n Proto compiler and four upstream code
generators as WASI Preview 1 command modules. Every host, from the browser to a
build system, drives the same modules through the same three-step pipeline.

## Data flow

```text
schema text, binary embeds, standard include schemas
       |
       |  staged read-only as /src and /include (the launcher: one --dir as /)
       v
+--------------------------------------------------------------+
| capnp.wasm  compile --no-standard-import -I/include -o- ...  |
| upstream compiler, WASI port from patches/capnproto;         |
| argv, stdin, stdout, stderr only; generator launch rejected  |
+--------------------------------------------------------------+
       |
       |  stdout: one unpacked CodeGeneratorRequest (standard binary message)
       v
+-----------------+ +------------------+ +----------------+ +-----------------+
| capnpc-c++.wasm | | capnpc-rust.wasm | | capnpc-go.wasm | | capnpc-zig.wasm |
+-----------------+ +------------------+ +----------------+ +-----------------+
  one fresh instance per generator; request on stdin; empty writable / as cwd;
  files created under /; capnpc-capnp.wasm prints the schema to stdout instead
       |
       |  outputs published only after exit 0 (SDKs: never partially)
       v
TypeScript SDK (browser_wasi_shim, in-memory files, direct or worker)
Go SDK (wazero, private memory filesystem)
bin/capnp-wasm launcher (Wasmtime, host directories)
```

The `CodeGeneratorRequest` bytes are the contract between the stages. They are
the standard Cap'n Proto format, so a request produced by the native `capnp`
tool, by `capnp.wasm` on any host, or saved from an earlier run can be fed to
any generator on any host. Both SDKs expose that as `generate`.

## Stages and who owns them

| Stage                     | Implementation                                                                                                                                          | Directory                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Compiler and C++ tools    | Upstream Cap'n Proto v2 at the pinned `ref/capnproto` commit, with one patch that makes the synchronous commands WASI programs; built with the WASI SDK | `patches/capnproto/`, `cmake/`, `scripts/build-wasm.sh`                |
| Rust generator            | A small wrapper around upstream `capnpc::codegen`, pinned through Cargo path dependencies on `ref/capnproto-rust`                                       | `generators/rust/`                                                     |
| Go generator              | Upstream `capnpc-go` compiled for `wasip1`, pinned through a module replacement on `ref/go-capnp`                                                       | `generators/go/`                                                       |
| Zig generator and runtime | Upstream `capnp-zig` built pristine for native and `wasm32-wasi`; `sync.json` proves the exported tree matches the pinned commit                        | `generators/zig/`, `scripts/build-zig.sh`, `scripts/check-zig-sync.ts` |
| TypeScript host           | `createCompiler` (direct) and `createWorkerCompiler` (worker) over `browser_wasi_shim` with bounded in-memory files and memory                          | `sdk/typescript/`                                                      |
| Go host                   | `capnpcwasm.New`, `Compile`, `Generate` over wazero's compiler engine with a private memory filesystem per command                                      | `sdk/go/`                                                              |
| Launcher                  | `bin/capnp-wasm`: Bash over a pinned Wasmtime; one host directory mapped as guest `/`                                                                   | `bin/`, `docs/releases.md`                                             |
| Schema Studio             | A static browser workbench over the worker SDK                                                                                                          | `examples/browser/`, `scripts/build-studio.ts`                         |
| Development runners       | Command hosts over trusted staging directories for the Deno shim and wazero                                                                             | `tests/hosts/`                                                         |

## Build pipeline

`mise run build` produces two trees from the pristine references. Native tools
(`build/native/bin/`: `capnp`, `capnpc-c++`, `capnpc-capnp`, `capnpc-rust`,
`capnpc-go`, `capnpc-zig`, `normalize-request`) come from the unmodified
upstream sources and serve as the test oracle. Wasm commands (`build/wasm/bin/`)
come from disposable source copies under `build/src/`, where the C++ port patch
is applied and the Zig sources are exported. `build:sdk` bundles the TypeScript
SDK and copies the commands, standard schemas, and licenses into `dist/`;
`release:prepare`, `release:tools`, and `release:compiler-host` turn `dist/`
into reproducible archives under `dist/releases/` with a manifest, provenance,
and `SHA256SUMS`.

## Verification oracles

- Native parity: every host compiles the same workspace and generates the same
  targets; the canonical binary request (after sorting only `nodes` and
  `sourceInfo`) and every generated byte must equal the native tools' output.
  The hosts under test are Wasmtime, wazero (compiler and interpreter), the Deno
  shim runner, both SDKs, and three browsers.
- Generated-code execution: C++, Rust, Go, and Zig consumers compile the Wasm
  generators' output against the pinned runtimes and round-trip messages.
- Zig runtime conformance: reflection, generated Builder, generic API, RPC
  codegen, and wire suites compile and run natively and under WASI, with an
  independent C++ oracle and the historical audit revision as a regression
  control.
- Failure behavior: malformed schemas and requests must fail without output,
  guest process launching must be rejected, and resource limits must trap
  without partial results.
- Packaging: archives must be reproducible, verifiable, tamper-rejecting, and
  usable by external Deno and Go consumers and by the launcher.

## Invariants

- The binary `CodeGeneratorRequest` is the only interface between compiler and
  generators; hosts orchestrate generators, guests never launch them.
- Every command runs in a fresh instance with a fresh filesystem; the compiler's
  inputs are read-only; outputs are published only after success.
- Modules import only `wasi_snapshot_preview1` and require standardized Wasm
  exception handling (the C++ tools use exceptions); the feature profile is
  validated on every build.
- References under `ref/` stay pristine; project changes live in patches,
  wrappers, and disposable copies under `build/`.
