#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p dist/typescript
deno bundle --config sdk/typescript/deno.json --unstable-sloppy-imports \
  --platform browser --format esm --declaration \
  -o dist/typescript/mod.js sdk/typescript/mod.ts
deno bundle --config sdk/typescript/deno.json --unstable-sloppy-imports \
  --platform browser --format esm \
  -o dist/typescript/worker.js sdk/typescript/worker.ts
deno run --allow-read --allow-write=dist scripts/package-assets.ts
