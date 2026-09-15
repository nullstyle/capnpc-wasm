#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

source_dir=build/src/capnp-zig
revision="$(git -C ref/capnp-zig rev-parse HEAD)"
source_key="$revision:pristine-v1"
historical_dir=build/src/capnp-zig-historical
historical_revision="$(cat generators/zig/historical-reference)"

# BSD tar can stop at the end markers before git has written the remaining
# archive padding. With pipefail, that harmless early close becomes SIGPIPE (exit 141).
# Finish the archive first, then publish only a fully extracted source tree.
export_source() (
  local source_revision="$1" destination="$2" key="$3" staging
  staging="$(mktemp -d build/src/.capnp-zig-export.XXXXXX)"
  trap 'rm -rf "$staging"' EXIT
  git -C ref/capnp-zig archive --format=tar \
    --output="$PWD/$staging/source.tar" "$source_revision" src/
  mkdir "$staging/source"
  tar -xf "$staging/source.tar" -C "$staging/source"
  printf '%s\n' "$key" > "$staging/source/.source-key"
  rm -rf "$destination"
  mv "$staging/source" "$destination"
)

mkdir -p build/src build/native/bin build/wasm/bin build/zig/cache build/zig/bin
if [[ ! -f "$source_dir/.source-key" ]] ||
   [[ "$(cat "$source_dir/.source-key")" != "$source_key" ]]; then
  export_source "$revision" "$source_dir" "$source_key"
fi

if [[ ! -f "$historical_dir/.source-key" ]] ||
   [[ "$(cat "$historical_dir/.source-key")" != "$historical_revision" ]]; then
  git -C ref/capnp-zig cat-file -e "$historical_revision^{commit}" || {
    echo 'Historical Zig audit reference missing; run mise run refs:sync' >&2
    exit 1
  }
  export_source "$historical_revision" "$historical_dir" "$historical_revision"
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
