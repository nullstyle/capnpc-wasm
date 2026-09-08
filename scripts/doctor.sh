#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

mise ls --current
clang --version
clang++ --version
cmake --version
ninja --version
rustc --version
cargo --version
go version
deno --version
zig version
wasm-tools --version
read -r _ wasm_tools_version _ <<< "$(wasm-tools --version)"
if [[ "$wasm_tools_version" != "$(mise current wasm-tools)" ]]; then
  echo "wasm-tools on PATH differs from the mise pin; check tool ordering." >&2
  exit 1
fi
wasmtime --version
shellcheck --version

sdk_path="$(mise where wasi-sdk)"
if [[ ! -x "$sdk_path/bin/clang" || ! -x "$sdk_path/bin/clang++" ||
      ! -d "$sdk_path/share/wasi-sysroot" ||
      ! -f "$sdk_path/share/cmake/wasi-sdk-p1.cmake" ]]; then
  echo "Incomplete WASI SDK installation at $sdk_path; run mise install." >&2
  exit 1
fi
"$sdk_path/bin/clang" --version

rust_wasi_libdir="$(rustc --print target-libdir --target wasm32-wasip1)"
if ! compgen -G "$rust_wasi_libdir/libstd-*.rlib" > /dev/null; then
  echo "Missing Rust wasm32-wasip1 standard library; run mise install." >&2
  exit 1
fi

ref_status="$(git submodule status)"
printf '%s\n' "$ref_status"
if [[ -z "$ref_status" ]] || [[ "$ref_status" =~ (^|$'\n')[-+U] ]]; then
  echo "References are missing or differ from their recorded commits; run mise run refs:sync." >&2
  exit 1
fi

echo "Setup checks passed. Compiler and host compatibility tests will follow implementation."
