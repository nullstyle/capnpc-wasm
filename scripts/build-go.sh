#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Build the pinned upstream main package directly, including its in-process
# go/format implementation. Both targets use the same dependency lockfile.
mkdir -p build/native/bin build/wasm/bin
CGO_ENABLED=0 go -C generators/go build -mod=readonly -trimpath \
  -o ../../build/native/bin/capnpc-go capnproto.org/go/capnp/v3/capnpc-go
CGO_ENABLED=0 GOOS=wasip1 GOARCH=wasm go -C generators/go build \
  -mod=readonly -trimpath -o ../../build/wasm/bin/capnpc-go.wasm \
  capnproto.org/go/capnp/v3/capnpc-go
wasm-tools validate \
  --features=-legacy-exceptions,-threads,-shared-everything-threads,-memory64 \
  build/wasm/bin/capnpc-go.wasm
