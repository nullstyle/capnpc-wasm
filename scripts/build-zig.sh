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

# The historical audit revision is exported for the wire conformance probes;
# its command is no longer built (nothing consumed it).
if [[ ! -f "$historical_dir/.source-key" ]] ||
   [[ "$(cat "$historical_dir/.source-key")" != "$historical_revision" ]]; then
  git -C ref/capnp-zig cat-file -e "$historical_revision^{commit}" || {
    echo 'Historical Zig audit reference missing; run mise run refs:sync' >&2
    exit 1
  }
  export_source "$historical_revision" "$historical_dir" "$historical_revision"
fi
rm -f build/zig/bin/capnpc-zig-upstream build/native/bin/capnpc-zig-upstream

deno run --allow-read --allow-run=git scripts/check-zig-sync.ts

# Compile main directly, without the RPC build graph or a second emitter.
# Each output carries a stamp of everything that determines it, so an
# unchanged source, toolchain, and flag set skips the compile entirely.
zig_version="$(zig version)"
script_hash="$(git hash-object "$0")"

compile() {
  # usage: compile <name> <output> <zig flags...>
  local name="$1" output="$2" stamp_file want
  shift 2
  stamp_file="build/zig/$name.stamp"
  want="zig=$zig_version|source=$source_key|script=$script_hash|flags=$*"
  if [[ -f "$output" && -f "$stamp_file" ]] &&
     [[ "$(cat "$stamp_file")" == "$want" ]]; then
    echo "$name is up to date"
    return 0
  fi
  rm -f "$stamp_file"
  zig build-exe "$source_dir/src/main.zig" "$@" --cache-dir build/zig/cache \
    -femit-bin="$output.tmp"
  mv -f "$output.tmp" "$output"
  printf '%s\n' "$want" > "$stamp_file"
}

# The native and WASI compiles share the Zig cache, which locks its entries,
# so they run concurrently.
pids=()
compile native build/zig/bin/capnpc-zig -O ReleaseSafe -fstrip &
pids+=($!)
compile wasi build/zig/bin/capnpc-zig.wasm -O ReleaseSafe -fstrip \
  -target wasm32-wasi --stack 8388608 &
pids+=($!)
failed=0
for pid in "${pids[@]}"; do
  wait "$pid" || failed=1
done
if [[ "$failed" -ne 0 ]]; then
  echo "Zig generator build failed" >&2
  exit 1
fi

wasm-tools validate \
  --features=-legacy-exceptions,-threads,-shared-everything-threads,-memory64 \
  build/zig/bin/capnpc-zig.wasm

install_if_changed() {
  # usage: install_if_changed <source> <destination>; leaves an identical
  # destination untouched so dependents keep their timestamps.
  if [[ -f "$2" ]] && cmp -s "$1" "$2"; then
    return 0
  fi
  cp "$1" "$2.tmp"
  mv -f "$2.tmp" "$2"
}
install_if_changed build/zig/bin/capnpc-zig build/native/bin/capnpc-zig
install_if_changed build/zig/bin/capnpc-zig.wasm build/wasm/bin/capnpc-zig.wasm
