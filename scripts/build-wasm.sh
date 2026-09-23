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
wasm_toolchain="$wasm_toolchain|clang=$("$sdk_path/bin/clang" --version | head -n 1)"
wasm_toolchain="$wasm_toolchain|toolchain-file=$(git hash-object "$sdk_path/share/cmake/wasi-sdk-p1.cmake")"
wasm_toolchain="$wasm_toolchain|cmakelists=$(git hash-object cmake/CMakeLists.txt)"
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
for tool in capnp capnpc-c++ capnpc-capnp; do
  wasm-tools validate \
    --features=-legacy-exceptions,-threads,-shared-everything-threads,-memory64 \
    "build/wasm/bin/$tool.wasm"
done
