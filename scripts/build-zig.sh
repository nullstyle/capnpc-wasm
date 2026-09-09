#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

source_dir=build/src/capnp-zig
revision="$(git -C ref/capnp-zig rev-parse HEAD)"
source_key="$revision:pristine-v1"
historical_dir=build/src/capnp-zig-historical
historical_revision="$(cat generators/zig/historical-reference)"

mkdir -p build/src build/native/bin build/wasm/bin build/zig/cache build/zig/bin
if [[ ! -f "$source_dir/.source-key" ]] ||
   [[ "$(cat "$source_dir/.source-key")" != "$source_key" ]]; then
  rm -rf "$source_dir"
  mkdir -p "$source_dir"
  git -C ref/capnp-zig archive "$revision" src/ | tar -x -C "$source_dir"
  printf '%s\n' "$source_key" > "$source_dir/.source-key"
fi

if [[ ! -f "$historical_dir/.source-key" ]] ||
   [[ "$(cat "$historical_dir/.source-key")" != "$historical_revision" ]]; then
  git -C ref/capnp-zig cat-file -e "$historical_revision^{commit}" || {
    echo 'Historical Zig audit reference missing; run mise run refs:sync' >&2
    exit 1
  }
  rm -rf "$historical_dir"
  mkdir -p "$historical_dir"
  git -C ref/capnp-zig archive "$historical_revision" src/ | tar -x -C "$historical_dir"
  printf '%s\n' "$historical_revision" > "$historical_dir/.source-key"
fi

deno run --allow-read --allow-run=git scripts/check-zig-sync.ts

# Compile main directly, without the RPC build graph or a second emitter. Keep
# the old audit oracle separate from the current pristine native/WASI commands.
zig build-exe "$historical_dir/src/main.zig" \
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
