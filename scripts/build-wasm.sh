#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
# shellcheck source=scripts/lib/export-source.sh
source scripts/lib/export-source.sh
# shellcheck source=scripts/lib/cmake-configure.sh
source scripts/lib/cmake-configure.sh
# shellcheck source=scripts/lib/refs.sh
source scripts/lib/refs.sh
# shellcheck source=scripts/lib/lock.sh
source scripts/lib/lock.sh
acquire_build_lock build/locks/wasm
source_dir=build/src/capnproto
patch_file=patches/capnproto/0001-wasi-command-tools.patch
require_pristine_ref capnproto
revision="$(ref_revision capnproto)"
source_key="$revision:$(git hash-object "$patch_file")"

# Export the committed upstream sources with the port applied into a
# disposable copy. The snapshot is reused while the revision and patch match
# and its content digest is intact, so ordinary builds stay incremental.
ensure_source_export ref/capnproto "$revision" "$source_dir" "$source_key" \
  "$patch_file"

sdk_path="$(mise where wasi-sdk)"
# The CMake cache keeps the SDK, toolchain file, and compiler of its first
# configure; a changed toolchain stamp reconfigures from scratch.
wasm_toolchain="cmake=$(cmake --version | head -n 1)|wasi-sdk=$sdk_path"
wasm_toolchain="$wasm_toolchain|ninja=$(command -v ninja || echo missing)=$(ninja --version 2> /dev/null || echo missing)"
wasm_toolchain="$wasm_toolchain|clang=$("$sdk_path/bin/clang" --version | head -n 1)"
wasm_toolchain="$wasm_toolchain|toolchain-file=$(git hash-object "$sdk_path/share/cmake/wasi-sdk-p1.cmake")"
wasm_toolchain="$wasm_toolchain|cmakelists=$(git hash-object cmake/CMakeLists.txt)"
# The source directory is part of the compile flags (its prefix is mapped out
# of the modules), so a moved checkout reconfigures too.
wasm_toolchain="$wasm_toolchain|source-dir=$root/$source_dir"
# The cross build must not see the host linker fallback that
# scripts/lib/toolchain-env.sh may export in LDFLAGS: CMake seeds
# CMAKE_EXE_LINKER_FLAGS from it and the WASI clang would then use Apple's ld.
(
  unset LDFLAGS
  configure_cmake build/wasm "$wasm_toolchain" -S cmake -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="$sdk_path/share/cmake/wasi-sdk-p1.cmake" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCAPNP_SOURCE_DIR="$root/$source_dir" \
    -DCMAKE_RUNTIME_OUTPUT_DIRECTORY="$root/build/wasm/bin"
  cmake --build build/wasm
)
# The module contract (feature allow-list, no DWARF, no build-host paths,
# size budget) has one definition; check:wasm-artifacts applies it to dist/.
deno run --allow-read --allow-env=HOME --allow-run=wasm-tools \
  scripts/check-wasm-artifacts.ts --module build/wasm/bin/capnp.wasm \
  build/wasm/bin/capnpc-c++.wasm build/wasm/bin/capnpc-capnp.wasm
