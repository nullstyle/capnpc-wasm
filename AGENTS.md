# Working in capnp-wasm

This repository ports the reference Cap'n Proto tools and language generators to
Wasm commands for browsers, Deno, and wazero. The compiler and C++, Rust, Go,
and schema-inspection generators run across the development hosts and match
native output. Public SDKs, real browser tests, and the Zig guest are pending.

- Read [README.md](README.md) for bootstrap commands and workspace conventions.
  When working on a compiler, generator, or WASI boundary, use the relevant
  source entry points in [ref/README.md](ref/README.md).
- Run tools from the repository root through `mise run` or `mise exec --` so the
  root pins and environment apply. Running mise inside a reference can activate
  that upstream's unrelated configuration.
- Keep `ref/` as pristine, commit-pinned upstream material. Put project-owned
  wrappers and porting patches outside the submodules, and apply patches to
  disposable source copies under `build/`. Update gitlinks deliberately; normal
  setup restores their recorded commits.
- Keep tool versions in `mise.toml`, resolved tool metadata in `mise.lock`, and
  upstream revisions in Git submodule entries. When changing tools, regenerate
  the lockfile and run `mise run check`. Match Zig to the pinned generator's
  toolchain. Preserve the distinction between native Clang and WASI SDK Clang.
- When changing the C++ port or Wasm feature profile, read
  [patches/capnproto/README.md](patches/capnproto/README.md) and run
  `mise run test`. Tests compare canonical requests and generated files across
  actual host engines, including invalid-input failures. Keep test harnesses
  under `tests/hosts/` separate from future public SDK code.
- For Rust and Go generators, read [generators/README.md](generators/README.md).
  Keep language dependencies locked and resolved to the pinned references. Run
  `mise run test` after generator changes; generated-code consumers exercise the
  pinned runtimes as well as comparing source output.
- The target is WASI Preview 1 command modules (`wasm32-wasip1`). Cap'n Proto v2
  requires C++ exceptions: use standardized Wasm EH and retain error
  propagation. Preserve the standard binary `CodeGeneratorRequest` boundary and
  host orchestration of generators as implementation develops.
- Keep generated files and build trees under `build/`, distributable output
  under `dist/`, and project caches under `.cache/`. Add source directories when
  they acquire an implementation; maintain these instructions as conventions
  settle.
