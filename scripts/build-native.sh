#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
# shellcheck source=scripts/lib/cmake-configure.sh
source scripts/lib/cmake-configure.sh
# shellcheck source=scripts/lib/refs.sh
source scripts/lib/refs.sh
# shellcheck source=scripts/lib/lock.sh
source scripts/lib/lock.sh
acquire_build_lock build/locks/native

# The native tools and the test oracle build from the working tree, so it
# must be exactly the recorded upstream revision.
require_pristine_ref capnproto
revision="$(ref_revision capnproto)"

# LDFLAGS carries the linker fallback from scripts/lib/toolchain-env.sh when
# no installed SDK links; CMake reads it only on the first configure.
cmake_args=()
if [[ -n "${LDFLAGS:-}" ]]; then
  cmake_args+=(-DCMAKE_EXE_LINKER_FLAGS="$LDFLAGS")
fi
# The CMake cache keeps the compilers, SDK, and linker flags of its first
# configure; a changed toolchain stamp reconfigures from scratch.
native_toolchain="cmake=$(cmake --version | head -n 1)"
native_toolchain="$native_toolchain|ninja=$(command -v ninja || echo missing)=$(ninja --version 2> /dev/null || echo missing)"
native_toolchain="$native_toolchain|cc=${CC:-cc}=$(clang --version | head -n 1)"
native_toolchain="$native_toolchain|cxx=${CXX:-c++}=$(clang++ --version | head -n 1)"
native_sdk_path="${SDKROOT:-}"
if [[ -z "$native_sdk_path" && "$(uname -s)" == Darwin ]]; then
  native_sdk_path="$(xcrun --show-sdk-path 2> /dev/null || true)"
fi
native_toolchain="$native_toolchain|SDKROOT=${SDKROOT:-}|sdk=$native_sdk_path"
native_toolchain="$native_toolchain|LDFLAGS=${LDFLAGS:-}|capnproto=$revision"
configure_cmake build/native "$native_toolchain" -S ref/capnproto -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_TESTING=OFF -DBUILD_SHARED_LIBS=OFF \
  -DWITH_OPENSSL=OFF -DWITH_ZLIB=OFF -DWITH_FIBERS=OFF \
  -DCMAKE_RUNTIME_OUTPUT_DIRECTORY="$root/build/native/bin" \
  -DCMAKE_ARCHIVE_OUTPUT_DIRECTORY="$root/build/native/lib" \
  ${cmake_args[@]+"${cmake_args[@]}"}
cmake --build build/native --target capnp_tool capnpc_cpp capnpc_capnp

# Test-only oracle normalizes unordered request maps before canonical
# comparison. Relink it only when a source, a library, the flags, the SDK, or
# the compiler changed, and never let a failed link remove the previous binary.
normalize_src=tests/normalize-request.c++
normalize_bin=build/native/bin/normalize-request
normalize_stamp_file=build/native/normalize-request.stamp
normalize_libs=(
  build/native/lib/libcapnp.a
  build/native/lib/libkj-async.a
  build/native/lib/libkj.a
)
read -ra ldflags <<< "${LDFLAGS:-}"
normalize_cmd=(
  clang++ -std=c++23 -I ref/capnproto/c++/src "$normalize_src"
  "${normalize_libs[@]}" -pthread ${ldflags[@]+"${ldflags[@]}"}
)
normalize_stamp="$(printf '%s ' "${normalize_cmd[@]}")|SDKROOT=${SDKROOT:-}|$(clang++ --version | head -n 1)"

normalize_up_to_date() {
  local input
  [[ -x "$normalize_bin" && -f "$normalize_stamp_file" ]] || return 1
  [[ "$(cat "$normalize_stamp_file")" == "$normalize_stamp" ]] || return 1
  for input in "$normalize_src" "${normalize_libs[@]}"; do
    [[ "$normalize_bin" -nt "$input" ]] || return 1
  done
}

if normalize_up_to_date; then
  echo "normalize-request is up to date"
else
  rm -f "$normalize_stamp_file"
  "${normalize_cmd[@]}" -o "$normalize_bin.tmp"
  mv -f "$normalize_bin.tmp" "$normalize_bin"
  printf '%s\n' "$normalize_stamp" > "$normalize_stamp_file"
fi
