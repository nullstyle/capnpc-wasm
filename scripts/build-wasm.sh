#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
source_dir=build/src/capnproto
patch_file=patches/capnproto/0001-wasi-command-tools.patch
revision="$(git -C ref/capnproto rev-parse HEAD)"
source_key="$revision:$(git hash-object "$patch_file")"

# Export committed upstream sources. Reuse the snapshot only while both the
# source revision and patch match, so ordinary builds stay incremental.
mkdir -p build/src
if [[ ! -f "$source_dir/.source-key" ]] ||
   [[ "$(cat "$source_dir/.source-key")" != "$source_key" ]]; then
  rm -rf "$source_dir"
  mkdir -p "$source_dir"
  git -C ref/capnproto archive "$revision" | tar -x -C "$source_dir"
  git apply --check --directory="$source_dir" "$patch_file"
  git apply --directory="$source_dir" "$patch_file"
  printf '%s\n' "$source_key" > "$source_dir/.source-key"
fi

sdk_path="$(mise where wasi-sdk)"
# The cross build must not see the host linker fallback that
# scripts/lib/toolchain-env.sh may export in LDFLAGS: CMake seeds
# CMAKE_EXE_LINKER_FLAGS from it and the WASI clang would then use Apple's ld.
env -u LDFLAGS cmake -S cmake -B build/wasm -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$sdk_path/share/cmake/wasi-sdk-p1.cmake" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCAPNP_SOURCE_DIR="$root/$source_dir" \
  -DCMAKE_RUNTIME_OUTPUT_DIRECTORY="$root/build/wasm/bin"
env -u LDFLAGS cmake --build build/wasm
for tool in capnp capnpc-c++ capnpc-capnp; do
  wasm-tools validate \
    --features=-legacy-exceptions,-threads,-shared-everything-threads,-memory64 \
    "build/wasm/bin/$tool.wasm"
done
