#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/refs.sh
source scripts/lib/refs.sh
# shellcheck source=scripts/lib/lock.sh
source scripts/lib/lock.sh
acquire_build_lock build/locks/rust

# Cargo compiles the reference working tree through path dependencies, so it
# must be exactly the recorded upstream revision.
require_pristine_ref capnproto-rust

cargo build --locked --release --manifest-path generators/rust/Cargo.toml
cargo build --locked --release --manifest-path generators/rust/Cargo.toml \
  --target wasm32-wasip1

mkdir -p build/native/bin build/wasm/bin
cp "$CARGO_TARGET_DIR/release/capnpc-rust" build/native/bin/capnpc-rust
cp "$CARGO_TARGET_DIR/wasm32-wasip1/release/capnpc-rust.wasm" \
  build/wasm/bin/capnpc-rust.wasm
wasm-tools validate \
  --features=-legacy-exceptions,-threads,-shared-everything-threads,-memory64 \
  build/wasm/bin/capnpc-rust.wasm
