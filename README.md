# capnp-wasm

Workspace for porting the reference Cap'n Proto tools and code generators to
WebAssembly, for use in browsers, Deno, and wazero. The initial direction is
WASI Preview 1 command modules with C++, Rust, Go, and eventually Zig
generation.

This checkout currently contains development setup and upstream references. The
compiler port, host SDKs, and full project plan are still to come.

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

For future CMake cross builds, use
`$(mise where wasi-sdk)/share/cmake/wasi-sdk-p1.cmake` and explicitly target
`wasm32-wasip1`. Native and Wasm builds belong in separate build directories.

## Layout and references

| Path       | Contents                                                        |
| ---------- | --------------------------------------------------------------- |
| `ref/`     | Upstream Git submodules and their [source map](ref/README.md)   |
| `scripts/` | Project setup and verification scripts                          |
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
