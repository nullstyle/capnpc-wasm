#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"

cmake -S ref/capnproto -B build/native -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_TESTING=OFF -DBUILD_SHARED_LIBS=OFF \
  -DWITH_OPENSSL=OFF -DWITH_ZLIB=OFF -DWITH_FIBERS=OFF \
  -DCMAKE_RUNTIME_OUTPUT_DIRECTORY="$root/build/native/bin" \
  -DCMAKE_ARCHIVE_OUTPUT_DIRECTORY="$root/build/native/lib"
cmake --build build/native --target capnp_tool capnpc_cpp capnpc_capnp

# Test-only oracle normalizes unordered request maps before canonical comparison.
clang++ -std=c++23 -I ref/capnproto/c++/src tests/normalize-request.c++ \
  build/native/lib/libcapnp.a build/native/lib/libkj-async.a build/native/lib/libkj.a \
  -pthread -o build/native/bin/normalize-request
