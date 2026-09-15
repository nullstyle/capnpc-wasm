# capnpc-wasm

Cap'n Proto compiler and code generators running in WebAssembly.

The build produces WASI Preview 1 commands: `capnp.wasm`, `capnpc-c++.wasm`,
`capnpc-capnp.wasm`, `capnpc-rust.wasm`, `capnpc-go.wasm`, and
`capnpc-zig.wasm`. The same modules compile schemas and generate C++, Rust, Go,
and Zig in Wasmtime, wazero (compiler and interpreter), and Deno, Chromium,
Firefox, and WebKit using the pinned browser WASI shim. The TypeScript and Go
SDKs accept in-memory workspaces and return generated files. Tests compare them
with native output and compile and execute the generated source. C++, Rust, and
Go and Zig retain pristine upstream comparisons. Zig uses the matching pinned
generator and runtime, including
[binary schema reflection and generated views](generators/zig/README.md). The
TypeScript SDK bounds guest memory, inputs, requests, diagnostics, and outputs.
Compiler archives are available from this repository's
[public releases](https://github.com/nullstyle/capnpc-wasm/releases). Full SDK
registry publication and sustained nightly confidence remain release gates.

## Bootstrap

Install Git and [mise](https://mise.jdx.dev/getting-started.html), then run from
the repository root:

```sh
mise install
mise run setup
mise run check
# For real browser tests (downloads pinned engines into .cache/playwright):
mise run browser:install
mise run test:browser
```

Tool versions live in `mise.toml`; `mise.lock` records resolved downloads where
the backend supports them. Mise stores installed tools in its managed tool
directory, and the project redirects build output and working caches below this
checkout. Initial installation and reference fetching need network access.

The setup targets macOS and Linux on arm64 and x64. Native builds still need the
platform development SDK and linker (Xcode Command Line Tools on macOS, a system
C/C++ development environment on Linux). These host prerequisites are distinct
from the managed WASI SDK and its bundled target sysroot.

Use `mise exec -- <command>` when running tools directly. No shell activation,
globally installed Cap'n Proto compiler, Node installation, or second task
runner is required for this setup.

## Build and test

```sh
mise run build        # native reference tools and WASI modules
mise run test         # builds as needed, then runs the host comparison suite
mise run check        # adds formatting, lint, type, and environment checks
mise run test:browser # Chromium, Firefox, WebKit: offline execution and cancellation
```

Native tools are in `build/native/bin/`; Wasm commands are in `build/wasm/bin/`.
Wasm builds export the compiler sources into `build/src/`, apply the project
patch there, and leave `ref/` pristine. Test requests, generated source, and
canonical comparison data remain in `build/test/` for inspection after a
failure. The build also stages a standalone TypeScript module, worker, identical
Wasm commands, and standard include schemas under `dist/`.

Tests cover standard annotations, relative imports, unions, enums, interfaces,
byte-identical C++/Rust/Go/Zig output, native compilation of generated files,
Rust, Go, and Zig serialization roundtrips against pinned runtimes, schema
inspection, random IDs, malformed schemas/requests, and explicit rejection of
guest process launching. The native test oracle sorts only the request's `nodes`
and `sourceInfo` maps before comparing canonical binary messages; all other
ordering and pointer values are preserved.

The current [port and runtime profile](patches/capnproto/README.md) requires
standardized Wasm exception handling. Wasmtime uses `-W exceptions=y`; the
wazero hosts enable its experimental EH feature. The SDKs use isolated memory
filesystems; the older command runners under `tests/hosts/` remain development
harnesses over trusted staging directories. Real browser coverage uses the
Chromium, Firefox, and WebKit revisions pinned by Playwright.

## Host SDKs

The [TypeScript SDK](sdk/typescript/README.md) runs in Deno or a browser worker.
The [Go SDK](sdk/go/README.md) embeds wazero. Both compile modules once, use
fresh instances per command, and return generated files only after every
requested generator succeeds. Callers supply all module and schema bytes before
execution. Worker termination and Go context cancellation interrupt running
jobs. Both SDKs also expose standalone generation from saved compiler requests,
so an application can compile once and generate different target sets later.

```sh
mise run example:deno      # Rust generation using the bundled SDK
mise run example:browser   # Schema Studio at http://127.0.0.1:8080/
```

The browser test compares C++, Rust, Go, and Zig output against native
generation after disabling network access and native process creation. SDK tests
also exercise invalid paths, diagnostic preservation, failed-job isolation, and
cancellation of an infinite Wasm command. The shared
[feature corpus](tests/fixtures/features/README.md) covers binary embeds, 64-bit
limits, generic brands, pointer defaults, groups, and relative imports. The
[Schema Studio](examples/browser/README.md) browser workbench supports
multi-file schema editing, folder imports, C++/Rust/Go/Zig output, compiler
diagnostics, and source/output ZIP downloads. It loads generators on demand and
reuses the compiled request while its workspace is unchanged. These are initial
workspace SDKs. The [release guide](docs/releases.md) describes public compiler
downloads and testing a full SDK candidate with `mise run test:package`. Full
SDK registry publication and a stable release interface are pending.

## Repository toolchain integration

The release archives include a small Bash/Wasmtime launcher for build systems.
It runs schema compilation, binary conversion, and separately built WASI
language generators with explicit filesystem roots, preserving binary streams
and exit statuses. `mise run release:tools` creates a compiler-only archive for
consumers that pin their own generators; `mise run test:package` checks both
archive variants with real external consumers. See the
[launcher contract and examples](docs/releases.md#repository-toolchain-launcher).

`mise run release:compiler-host` prepares a separate compiler/TypeScript host
package for in-process Deno and browser consumers. It includes the compiler,
schemas, bundled host and worker, integrity data and licenses, without language
generator modules or the Go SDK. Its
[package gate](docs/releases.md#compiler-and-typescript-host-package) verifies
an offline external Deno consumer and worker cancellation/recovery.

Download the published
[compiler-only rc.2](https://github.com/nullstyle/capnpc-wasm/releases/tag/capnp-wasm-tools-v0.1.0-rc.2)
or
[compiler host rc.3](https://github.com/nullstyle/capnpc-wasm/releases/tag/capnp-wasm-compiler-host-v0.1.0-rc.3).
Pin the archive and manifest hashes described in the release guide.

## Command modules

After `mise run build`, create a request with the Wasm compiler, then feed it to
the generator in a separate output directory:

```sh
mkdir -p build/example/input/src build/example/input/include/capnp build/example/output
cp -R tests/fixtures/schemas/. build/example/input/src/
cp ref/capnproto/c++/src/capnp/c++.capnp build/example/input/include/capnp/
cp ref/go-capnp/std/go.capnp build/example/input/include/
mise exec -- wasmtime run -W exceptions=y --dir build/example/input::/ \
  build/wasm/bin/capnp.wasm compile --no-standard-import -I/include \
  --src-prefix=/src -o- /src/person.capnp /src/types/common.capnp > build/example/request.bin
mise exec -- wasmtime run -W exceptions=y --dir build/example/output::/ \
  build/wasm/bin/capnpc-c++.wasm < build/example/request.bin
```

The same request can be passed to `capnpc-rust.wasm`, `capnpc-go.wasm`, and
`capnpc-zig.wasm`, each with its own output directory. See
[generator details](generators/README.md) for language annotations, options, and
dependency conventions.

Each guest sees its staged root directory. Input schemas include the pinned
standard annotation files explicitly. Generate into a fresh output directory and
publish the output only after success.

## Tools

| Tools                                      | Purpose                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| Clang / clangxx, CMake, Ninja              | Native bootstrap tools and C++ build support                                 |
| WASI SDK                                   | C/C++ cross-compiler, target libraries, and CMake toolchain                  |
| Rust with `wasm32-wasip1`, rustfmt, Clippy | Rust generator development                                                   |
| Go                                         | Go generator and wazero host development; `GOTOOLCHAIN=local` honors the pin |
| Deno                                       | TypeScript tooling and host development                                      |
| Zig                                        | Existing `capnp-zig` generator's exact development toolchain                 |
| wasm-tools, Wasmtime                       | Wasm inspection, validation, and command smoke tests                         |
| ShellCheck                                 | Setup script validation                                                      |

The SDK's Clang is intentionally kept off `PATH` so native bootstrap builds use
native Clang. Resolve the cross-toolchain explicitly:

```sh
mise exec -- bash -c '"$(mise where wasi-sdk)/bin/clang" --version'
```

For CMake cross builds, use
`$(mise where wasi-sdk)/share/cmake/wasi-sdk-p1.cmake` and explicitly target
`wasm32-wasip1`. Native and Wasm builds belong in separate build directories.

## Layout and references

| Path          | Contents                                                           |
| ------------- | ------------------------------------------------------------------ |
| `ref/`        | Upstream Git submodules and their [source map](ref/README.md)      |
| `scripts/`    | Project setup, build, and verification scripts                     |
| `cmake/`      | Minimal synchronous C++ command build for WASI                     |
| `patches/`    | Documented upstream porting changes                                |
| `generators/` | Language command builds, wrappers, and pinned dependency manifests |
| `sdk/`        | TypeScript worker/in-memory SDK and Go wazero SDK                  |
| `examples/`   | Browser worker and Deno SDK examples                               |
| `tests/`      | Schema fixtures, native oracle, and development host runners       |
| `build/`      | Ignored build trees, scratch source copies, and generated files    |
| `dist/`       | Ignored SDK bundles, command modules, and standard schemas         |
| `.cache/`     | Ignored project caches                                             |

`mise run refs:sync` initializes only the top-level references at the commits
recorded by this repository. Their nested compiler sources, demos, and test
dependencies are intentionally left uninitialized. Avoid recursive cloning for
ordinary setup; a recursive WASI SDK checkout also fetches LLVM.

`mise run refs:status` shows the authoritative source revisions. The existing
Cap'n Proto revision is preserved; the WASI SDK source matches the SDK release.
The tests exercise the pinned C++, Rust, Go, and Zig revisions together. The
references do not imply compatibility with other upstream versions.

When intentionally updating a tool, edit its pin, run `mise install` and
`mise lock`, then run `mise run check` and review the lockfile diff. When
updating a reference, review its upstream changes and record the new gitlink.
Keep Zig's pin aligned with `ref/capnp-zig/mise.toml`.

## License

Copyright 2026 Scott Fleckenstein.

Project-owned code, including the TypeScript and Go SDKs, is licensed under the
[Apache License, Version 2.0](LICENSE). Reference sources and bundled upstream
components retain their own licenses, distributed in the package's `licenses/`
directory.
