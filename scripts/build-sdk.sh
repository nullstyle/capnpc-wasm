#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/lock.sh
source scripts/lib/lock.sh

# One publisher at a time; unique staging and backup names keep a concurrent
# invocation that is waiting for the lock from touching this run's files.
mkdir -p build dist
acquire_build_lock build/locks/sdk --no-trap
staging="$(mktemp -d dist/.sdk-staging.XXXXXX)"
backup="$(mktemp -d dist/.sdk-backup.XXXXXX)"
published=("")
cleanup() {
  local name
  for name in "${published[@]}"; do
    if [[ -n "$name" ]]; then rm -rf "dist/$name"; fi
  done
  for name in typescript wasm include licenses; do
    if [[ -d "$backup/$name" ]]; then mv "$backup/$name" "dist/$name"; fi
  done
  rm -rf "$staging" "$backup"
  release_build_lock
}
trap cleanup EXIT
mkdir -p "$staging/typescript"
deno bundle --config sdk/typescript/deno.json --unstable-sloppy-imports \
  --platform browser --format esm --declaration \
  -o "$staging/typescript/mod.js" sdk/typescript/mod.ts
deno bundle --config sdk/typescript/deno.json --unstable-sloppy-imports \
  --platform browser --format esm \
  -o "$staging/typescript/worker.js" sdk/typescript/worker.ts
deno run --allow-read --allow-write=dist --allow-run=go,rustc,mise \
  scripts/package-assets.ts "$staging"
for name in typescript wasm include licenses; do
  if [[ -d "dist/$name" ]]; then mv "dist/$name" "$backup/$name"; fi
  mv "$staging/$name" "dist/$name"
  published+=("$name")
done
# All directories were successfully replaced. Cleanup now only removes staging.
published=("")
rm -rf "$backup"
