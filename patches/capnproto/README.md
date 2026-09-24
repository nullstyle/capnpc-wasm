# Cap'n Proto WASI command port

`0001-wasi-command-tools.patch` applies to Cap'n Proto revision
`851c45bb39c34c3f20f9d9ebe9f34a7e39109b6f`, the `ref/capnproto` gitlink. Apply
it to a disposable copy of the upstream repository, never to `ref/capnproto`;
`scripts/build-wasm.sh` exports that revision under `build/src/capnproto` and
applies the patch there.

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
- Exit path: `TopLevelProcessContext` always uses clean shutdown, so `main()`
  returns its status and crt1 calls `proc_exit` only for a nonzero status from
  the outermost frame. `KJ_MAIN` constructs the main object inside
  `runMainAndExit()`'s exception envelope, and `DiskFilesystem` names a missing
  `/` preopen. See [Exit path](#exit-path) and
  [Filesystem](#filesystem-and-import-paths).

## Build

`cmake/CMakeLists.txt` selects only the synchronous libraries these commands
need and produces `capnp.wasm`, `capnpc-c++.wasm`, and `capnpc-capnp.wasm` with
WASI SDK 34's `wasi-sdk-p1.cmake` toolchain. Set `CAPNP_SOURCE_DIR` to the
patched upstream root, `CAPNP_PORT_PATCH` to the patch (its translation units
compile with `-Werror`; upstream's untouched units keep upstream's warning
policy), and optionally `CMAKE_RUNTIME_OUTPUT_DIRECTORY` and
`CAPNP_UNSTRIPPED_OUTPUT_DIRECTORY`. The build reads the CLI version string from
the pinned upstream CMake configuration for all three commands, compiles as
`gnu++23` like the native oracle, and fails at configure time when the kj and
capnp source lists no longer match upstream's CMake lists (minus the documented
exclusions: `thread`, `test-helpers`, `filesystem-disk-win32`).

Every translation unit is compiled with `-ffile-prefix-map=<c++/src>/=`, so
`__FILE__` and source locations read `kj/io.c++`, the form kj already trims
diagnostics to, and the module bytes do not depend on the checkout path. The
shipped modules are linked with `-Wl,--strip-debug`: the DWARF that the SDK
sysroot's prebuilt libc, libc++, and libunwind carry is dropped, and the `name`
section stays so engine traps remain symbolized. Copies with the DWARF are kept
under `build/wasm/unstripped/`.

## Runtime profile

- Exceptions: Cap'n Proto 2 requires C++ exceptions. The modules are compiled
  with `-fwasm-exceptions -mllvm -wasm-use-legacy-eh=false` and linked with
  `-fwasm-exceptions -lunwind`, which is the standardized WebAssembly exception
  handling proposal (`try_table`, `exnref`), not the legacy one. LTO is off
  because SDK 34 documents a known exception handling issue with it. Only the
  three C++ modules carry a tag section; `capnpc-rust.wasm`, `capnpc-go.wasm`,
  and `capnpc-zig.wasm` do not need exception support.
- RTTI is off (`-fno-rtti`, `KJ_NO_RTTI=1`). kj describes a non-kj exception as
  `unknown non-KJ exception` without its type name.
- Stack and memory: the linker reserves an 8 MiB linear stack
  (`-Wl,-z,stack-size=8388608`), so `capnp.wasm` and `capnpc-c++.wasm` declare
  130 pages of initial memory and `capnpc-capnp.wasm` 129, with no maximum. A
  host that bounds memory must allow at least the declared initial size; the
  TypeScript SDK rejects a `memoryPages` limit below it. Compiler recursion is
  bounded by the engine's call stack, not by this reservation.
- Single threaded: no `thread_*` imports and no shared memory. The modules
  import only `wasi_snapshot_preview1` functions and export `_start` and
  `memory`.
- Feature profile: the C++ modules use WebAssembly 2.0 without SIMD, plus
  standardized exceptions; the generator modules use the same baseline without
  reference types or exceptions. `scripts/check-wasm-artifacts.ts` defines the
  allow-lists, the exact `target_features` the C++ modules declare, the section
  rules, the path rules, and a size budget per module; the build scripts apply
  it to every module they link, `tests/toolchain_test.ts` applies it to
  `build/wasm/bin`, and `mise run check:wasm-artifacts` (part of `test`) to
  `dist/wasm`. Check a module by hand with:

  ```sh
  mise exec -- deno run --allow-read --allow-env=HOME --allow-run=wasm-tools \
    scripts/check-wasm-artifacts.ts --module build/wasm/bin/capnp.wasm
  ```

### Engines

The exception profile sets the minimum engine. Versions that enable standardized
exception handling by default, from
[webassembly.org/features](https://webassembly.org/features/): Chrome 137,
Firefox 131, Safari 18.4, Node.js 24.15, Deno 2.3.2, and Wasmtime 47. Wasmtime
needs `-W exceptions=y`. wazero keeps the feature behind its experimental
`CoreFeatures` flag; the pinned `ref/wazero` (`v1.12.0-17-g451613ca`) includes
`5f5f5200` ("compiler: try_table exception handling corrupts locals", #2504),
which the modules need, so an older wazero release is not sufficient. The
project tests only the pinned engines (see the support matrix in the root
README); on an older engine, compiling a module fails with an engine
`CompileError` for the `try_table` instruction.

## Filesystem and import paths

Each command needs a directory preopened at `/`, with stdin, stdout, and stderr
connected. The compiler and the C++ generator open `/` while their main objects
are constructed; without the preopen every command, including `capnp --version`,
exits 1 with:

```text
*** Uncaught exception ***
kj/filesystem-disk-unix.c++:<line>: failed: the host did not preopen a directory at "/"; this command needs the guest filesystem mounted there
```

`capnpc-capnp.wasm` reads only stdin and does not need the preopen.

The compiler's built-in schema include directory is `/include`
(`CAPNP_INCLUDE_DIR`). Unless `--no-standard-import` is given, the compiler also
searches the guest's `/usr/local/include` and `/usr/include` first, so files
staged there shadow `/include`. The SDKs pass `--no-standard-import` with
explicit `-I` paths; hosts that stage schemas under `/include` and rely on the
built-in path should stage nothing under `/usr`. Filesystem permissions, output
capture, resource limits, and publication of successful output belong to the
host.

## Exit path

On JavaScript hosts the WASI shim implements `proc_exit` as a thrown exception,
which Wasm exception handling unwinds through the C++ frames. kj's default of
calling `_exit()` from inside the program therefore ran destructors after "exit"
on those hosts (two `fd_close` calls per command, none under Wasmtime or
wazero), and a `noexcept` frame on the stack would have turned the exit into a
terminate trap. Under WASI the port always returns the status from `main()`: a
successful command returns from `_start` without calling `proc_exit`, and a
failing one calls it once from crt1's outermost frame with no WASI call after
it. `tests/toolchain_test.ts` asserts both on the shim.

Exceptions that reach `runMainAndExit()` are reported as
`*** Uncaught exception ***` with exit status 1 on every host. Wasm traps
(`unreachable`, stack exhaustion) and exceptions thrown outside that envelope
are reported by the engine instead: exit 134 under Wasmtime, 70 under the
development hosts.

## Generated code

`capnpc-c++.wasm` generates headers that `#error` against any `CAPNP_VERSION`
other than 2000000: the output needs the Cap'n Proto v2 runtime at the pinned
commit (`2.0-dev`), built from `ref/capnproto`; no upstream release matches. The
scheduled `upstream-canary` workflow stages the tip of upstream's `v2` branch in
the runner, applies this patch, builds, and runs the parity suites, so drift
(the patch no longer applying, changed source lists, a warning in a port unit,
or a parity failure) shows up without moving the pin. Bump `ref/capnproto` with
the checklist in `CONTRIBUTING.md`.

This port is not a general WASI port of KJ's threading, asynchronous I/O, or RPC
libraries.
