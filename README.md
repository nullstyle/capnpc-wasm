# capnp-wasm

Workspace for porting the reference Cap'n Proto tools and code generators to
WebAssembly, for use in browsers, Deno, and wazero. The initial direction is
WASI Preview 1 command modules with C++, Rust, Go, and eventually Zig
generation.

The first working slice builds `capnp.wasm`, `capnpc-c++.wasm`, and
`capnpc-capnp.wasm`. The same modules compile schemas and generate C++ in
Wasmtime, wazero (compiler and interpreter), and Deno using the pinned browser
WASI shim. Tests compare them with native upstream output. Browser execution,
public SDKs, Rust/Go/Zig generator guests, and release packaging are still
ahead.

## Bootstrap

Install Git and [mise](https://mise.jdx.dev/getting-started.html), then run from
the repository root:

```sh
mise install
mise run setup
mise run check
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
```

Native tools are in `build/native/bin/`; Wasm commands are in `build/wasm/bin/`.
Wasm builds export the compiler sources into `build/src/`, apply the project
patch there, and leave `ref/` pristine. Test requests, generated C++, and
canonical comparison data remain in `build/test/` for inspection after a
failure.

Tests cover standard annotations, relative imports, unions, enums, interfaces,
byte-identical C++ output, native compilation of generated files, schema
inspection, random IDs, malformed schemas/requests, and explicit rejection of
guest process launching. The native test oracle sorts only the request's `nodes`
and `sourceInfo` maps before comparing canonical binary messages; all other
ordering and pointer values are preserved.

The current [port and runtime profile](patches/capnproto/README.md) requires
standardized Wasm exception handling. Wasmtime uses `-W exceptions=y`; the
wazero test runner enables its experimental EH feature. The Deno runner
exercises the browser shim's in-memory WASI implementation; browser
compatibility still needs real browser tests. Host runners are development
harnesses over trusted staging directories.

After `mise run build`, create a request with the Wasm compiler, then feed it to
the generator in a separate output directory:

```sh
mkdir -p build/example/input/src build/example/input/include/capnp build/example/output
cp -R tests/fixtures/schemas/. build/example/input/src/
cp ref/capnproto/c++/src/capnp/c++.capnp build/example/input/include/capnp/
mise exec -- wasmtime run -W exceptions=y --dir build/example/input::/ \
  build/wasm/bin/capnp.wasm compile --no-standard-import -I/include \
  --src-prefix=/src -o- /src/person.capnp /src/types/common.capnp > build/example/request.bin
mise exec -- wasmtime run -W exceptions=y --dir build/example/output::/ \
  build/wasm/bin/capnpc-c++.wasm < build/example/request.bin
```

Each guest sees its staged root directory. Input schemas include the pinned
standard annotation file explicitly. Generate into a fresh output directory and
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

| Path       | Contents                                                        |
| ---------- | --------------------------------------------------------------- |
| `ref/`     | Upstream Git submodules and their [source map](ref/README.md)   |
| `scripts/` | Project setup, build, and verification scripts                  |
| `cmake/`   | Minimal synchronous C++ command build for WASI                  |
| `patches/` | Documented upstream porting changes                             |
| `tests/`   | Schema fixtures, native oracle, and development host runners    |
| `build/`   | Ignored build trees, scratch source copies, and generated files |
| `dist/`    | Ignored distributable output                                    |
| `.cache/`  | Ignored project caches                                          |

`mise run refs:sync` initializes only the top-level references at the commits
recorded by this repository. Their nested compiler sources, demos, and test
dependencies are intentionally left uninitialized. Avoid recursive cloning for
ordinary setup; a recursive WASI SDK checkout also fetches LLVM.

`mise run refs:status` shows the authoritative source revisions. The existing
Cap'n Proto revision is preserved; the WASI SDK source matches the SDK release.
Other references are development snapshots for investigation, not a tested
compatibility matrix or runtime package dependency declaration.

When intentionally updating a tool, edit its pin, run `mise install` and
`mise lock`, then run `mise run check` and review the lockfile diff. When
updating a reference, review its upstream changes and record the new gitlink.
Keep Zig's pin aligned with `ref/capnp-zig/mise.toml`.
