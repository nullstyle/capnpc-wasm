#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

staging=dist/.sdk-staging
backup=dist/.sdk-backup
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
}
trap cleanup EXIT
rm -rf "$staging" "$backup"
mkdir -p "$staging/typescript" "$backup"
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
