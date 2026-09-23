#!/usr/bin/env bash
# shellcheck shell=bash
#
# CMake configuration with a toolchain stamp. Sourced by the build scripts;
# the caller sets `set -euo pipefail`.
#
# configure_cmake <build dir> <toolchain stamp> <cmake args...>
#   Runs `cmake -B <build dir> <cmake args...>`. A CMake cache remembers the
#   compilers, SDK, and flags of its first configure, so when <toolchain stamp>
#   (whatever the caller considers part of the toolchain: compiler versions,
#   SDK paths, linker flags, the CMakeLists hash) differs from the one recorded
#   in the build directory, the configure runs with --fresh and discards the
#   cache. The stamp is written only after a successful configure.

configure_cmake() {
  local build_dir="$1" stamp="$2" stamp_file fresh=()
  shift 2
  stamp_file="$build_dir/.toolchain-stamp"
  if [[ -f "$build_dir/CMakeCache.txt" ]]; then
    if [[ ! -f "$stamp_file" ]] || [[ "$(cat "$stamp_file")" != "$stamp" ]]; then
      echo "toolchain changed; reconfiguring $build_dir from scratch" >&2
      fresh=(--fresh)
    fi
  fi
  mkdir -p "$build_dir"
  rm -f "$stamp_file"
  cmake ${fresh[@]+"${fresh[@]}"} -B "$build_dir" "$@"
  printf '%s\n' "$stamp" > "$stamp_file"
}
