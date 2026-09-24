#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/export-source.sh
source scripts/lib/export-source.sh
# shellcheck source=scripts/lib/refs.sh
source scripts/lib/refs.sh
# shellcheck source=scripts/lib/lock.sh
source scripts/lib/lock.sh
acquire_build_lock build/locks/zig

require_pristine_ref capnp-zig
source_dir=build/src/capnp-zig
revision="$(ref_revision capnp-zig)"
source_key="$revision:pristine-v1"
historical_dir=build/src/capnp-zig-historical
historical_revision="$(cat generators/zig/historical-reference)"

mkdir -p build/native/bin build/wasm/bin build/zig/cache build/zig/bin
# Exact disposable copies of the pinned runtime and generator sources; the
# export is reused while its key matches and its content digest is intact.
ensure_source_export ref/capnp-zig "$revision" "$source_dir" "$source_key" "" src/

# The historical audit revision is exported for the wire conformance probes;
# its command is no longer built (nothing consumed it).
git -C ref/capnp-zig cat-file -e "$historical_revision^{commit}" || {
  echo 'Historical Zig audit reference missing; run mise run refs:sync' >&2
  exit 1
}
ensure_source_export ref/capnp-zig "$historical_revision" "$historical_dir" \
  "$historical_revision" "" src/
rm -f build/zig/bin/capnpc-zig-upstream build/native/bin/capnpc-zig-upstream

deno run --allow-read --allow-run=git scripts/check-zig-sync.ts

# Compile main directly, without the RPC build graph or a second emitter.
# Each output carries a stamp of everything that determines it, so an
# unchanged source, toolchain, and flag set skips the compile entirely.
zig_version="$(zig version)"
script_hash="$(git hash-object scripts/build-zig.sh)"

compile() {
  # usage: compile <name> <output> <zig flags...>
  local name="$1" output="$2" stamp_file want emit_dir
  shift 2
  stamp_file="build/zig/$name.stamp"
  want="zig=$zig_version|source=$source_key|script=$script_hash|flags=$*"
  if [[ -f "$output" && -f "$stamp_file" ]] &&
     [[ "$(cat "$stamp_file")" == "$want" ]]; then
    echo "$name is up to date"
    return 0
  fi
  rm -f "$stamp_file"
  # Emit under the final name in a temporary directory: the macOS ad-hoc code
  # signature identifier is the file name, and a failed compile must leave
  # the previous output in place.
  emit_dir="$(mktemp -d build/zig/.emit.XXXXXX)"
  if ! zig build-exe "$source_dir/src/main.zig" "$@" --cache-dir build/zig/cache \
    -femit-bin="$emit_dir/${output##*/}"; then
    rm -rf "$emit_dir"
    return 1
  fi
  mv -f "$emit_dir/${output##*/}" "$output"
  rm -rf "$emit_dir"
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

# The module contract (feature allow-list, no DWARF, no build-host paths,
# size budget) has one definition; check:wasm-artifacts applies it to dist/.
deno run --allow-read --allow-env=HOME --allow-run=wasm-tools \
  scripts/check-wasm-artifacts.ts --module build/zig/bin/capnpc-zig.wasm

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
