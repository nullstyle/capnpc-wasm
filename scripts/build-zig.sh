#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

source_dir=build/src/capnp-zig
patch_files=(patches/capnp-zig/*.patch)
revision="$(git -C ref/capnp-zig rev-parse HEAD)"
source_key="$revision:$(git hash-object "${patch_files[@]}")"

mkdir -p build/src build/native/bin build/wasm/bin build/zig/cache build/zig/bin
if [[ ! -f "$source_dir/.source-key" ]] ||
   [[ "$(cat "$source_dir/.source-key")" != "$source_key" ]]; then
  rm -rf "$source_dir"
  mkdir -p "$source_dir"
  git -C ref/capnp-zig archive "$revision" src/ | tar -x -C "$source_dir"
  for patch_file in "${patch_files[@]}"; do
    git apply --check --directory="$source_dir" "$patch_file"
    git apply --directory="$source_dir" "$patch_file"
  done
  printf '%s\n' "$source_key" > "$source_dir/.source-key"
fi

# Compile main directly, without the RPC build graph or a second emitter. Keep
# an unmodified oracle as well as the patched native/WASI commands, so tests can
# verify unchanged output outside the contextual import-path correction.
zig build-exe ref/capnp-zig/src/main.zig \
  -O ReleaseSafe -fstrip --cache-dir build/zig/cache \
  -femit-bin=build/zig/bin/capnpc-zig-upstream
zig build-exe "$source_dir/src/main.zig" \
  -O ReleaseSafe -fstrip --cache-dir build/zig/cache \
  -femit-bin=build/zig/bin/capnpc-zig
zig build-exe "$source_dir/src/main.zig" \
  -O ReleaseSafe -fstrip --cache-dir build/zig/cache \
  -target wasm32-wasi --stack 8388608 \
  -femit-bin=build/zig/bin/capnpc-zig.wasm
wasm-tools validate \
  --features=-legacy-exceptions,-threads,-shared-everything-threads,-memory64 \
  build/zig/bin/capnpc-zig.wasm
for tool in capnpc-zig capnpc-zig-upstream; do
  cp "build/zig/bin/$tool" "build/native/bin/$tool.tmp"
  mv "build/native/bin/$tool.tmp" "build/native/bin/$tool"
done
cp build/zig/bin/capnpc-zig.wasm build/wasm/bin/capnpc-zig.wasm.tmp
mv build/wasm/bin/capnpc-zig.wasm.tmp build/wasm/bin/capnpc-zig.wasm
