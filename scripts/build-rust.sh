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

# Panic locations and other embedded paths name the checkout and the Cargo
# home; map both to fixed names so the module's bytes do not depend on where
# it was built (Cargo's trim-paths profile is unstable in the pinned
# toolchain). Only the WASI build gets them: CARGO_ENCODED_RUSTFLAGS would
# override the host-triple rustflags the toolchain environment may set for
# the native link. Rustflags from the environment stay in front.
root="$PWD"
wasm_rustflags=()
if [[ -n "${CARGO_ENCODED_RUSTFLAGS:-}" ]]; then
  IFS=$'\x1f' read -r -a wasm_rustflags <<< "$CARGO_ENCODED_RUSTFLAGS"
elif [[ -n "${RUSTFLAGS:-}" ]]; then
  read -r -a wasm_rustflags <<< "$RUSTFLAGS"
fi
wasm_rustflags+=(
  "--remap-path-prefix=$root=/capnpc-wasm"
  "--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo-home"
)
encoded_rustflags="$(IFS=$'\x1f'; printf '%s' "${wasm_rustflags[*]}")"
CARGO_ENCODED_RUSTFLAGS="$encoded_rustflags" cargo build --locked --release \
  --manifest-path generators/rust/Cargo.toml --target wasm32-wasip1

mkdir -p build/native/bin build/wasm/bin
cp "$CARGO_TARGET_DIR/release/capnpc-rust" build/native/bin/capnpc-rust
cp "$CARGO_TARGET_DIR/wasm32-wasip1/release/capnpc-rust.wasm" \
  build/wasm/bin/capnpc-rust.wasm
wasm-tools validate \
  --features=-legacy-exceptions,-threads,-shared-everything-threads,-memory64 \
  build/wasm/bin/capnpc-rust.wasm
