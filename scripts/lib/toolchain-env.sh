#!/usr/bin/env bash
# shellcheck shell=bash
#
# Native toolchain environment for capnpc-wasm.
#
# mise sources this file for every `mise run` and `mise exec --` (mise.toml:
# `[env] _.source` with `tools = true`, so the pinned compilers are already on
# PATH). Every child process inherits what it exports: cc (rustc's linker
# driver), clang++ (CMake, normalize-request, generated-code checks), CMake,
# cargo/rustc, and the test runners.
#
# It exports nothing while the pinned clang links a C and a C++23 program
# against the host's default macOS SDK (Linux and macOS 15 CI). When that link
# fails (the pinned conda ld64 rejects TBD stubs of a newer SDK), it exports
# the newest installed SDK that links as SDKROOT. If no SDK links, it exports
# Xcode's linker through LDFLAGS and Cargo's host-target rustflags. The probe
# result is cached under build/toolchain-env/ so mise startup stays fast; the
# key covers the kernel, the default SDK path and version, and the pinned
# compiler installs. Delete build/ or that directory to probe again.
#
# Set SDKROOT yourself (shell or mise.local.toml) to bypass the probe.
#
# This file is sourced: it must never exit or `set -e`, must stay bash 3.2
# compatible, and must leave nothing behind except its exports.

capnp_wasm_toolchain_links() {
  # usage: capnp_wasm_toolchain_links <work dir> <env assignment or ''> [flags...]
  local work="$1" assignment="$2"
  shift 2
  rm -f "$work/c.out" "$work/cxx.out"
  env ${assignment:+"$assignment"} cc "$@" -o "$work/c.out" "$work/probe.c" \
    > /dev/null 2>&1 || return 1
  [ "$("$work/c.out" 2> /dev/null)" = ok ] || return 1
  if command -v clang++ > /dev/null 2>&1; then
    env ${assignment:+"$assignment"} clang++ -std=c++23 "$@" \
      -o "$work/cxx.out" "$work/probe.cpp" > /dev/null 2>&1 || return 1
    [ "$("$work/cxx.out" 2> /dev/null)" = ok ] || return 1
  fi
  return 0
}

capnp_wasm_toolchain_sdks() {
  # Installed macOS SDKs, newest first, one real path per line, without the
  # default SDK given as $1 (it already failed the probe). $2 is the active
  # developer directory.
  local skip="$1" developer="$2" dir sdk version major minor real
  for dir in /Library/Developer/CommandLineTools/SDKs \
    "$developer/Platforms/MacOSX.platform/Developer/SDKs"; do
    for sdk in "$dir"/MacOSX[0-9]*.sdk; do
      [ -d "$sdk" ] || continue
      real="$(cd "$sdk" 2> /dev/null && pwd -P)" || continue
      [ "$real" != "$skip" ] || continue
      version="${sdk##*/MacOSX}"
      version="${version%.sdk}"
      major="${version%%.*}"
      minor="${version#*.}"
      [ "$minor" != "$version" ] || minor=0
      case "$major$minor" in *[!0-9]*) continue ;; esac
      printf '%08d%08d\t%s\n' "$major" "$minor" "$real"
    done
  done | sort -r | awk -F '\t' '!seen[$2]++' | cut -f 2-
}

capnp_wasm_toolchain_env() {
  local root cache_dir cache_file key mode value line work candidate ld triple
  local cc_path cxx_path sdk_path sdk_real sdk_version cc_stamp cxx_stamp
  local cached_key cached_mode cached_value existing developer

  [ "$(uname -s 2> /dev/null)" = Darwin ] || return 0
  [ -z "${SDKROOT:-}" ] || return 0
  # Before `mise install` there is no pinned compiler to probe.
  cc_path="$(command -v cc 2> /dev/null)" || return 0
  # Without developer tools nothing links, and xcrun would only prompt for
  # their installation; doctor reports the missing host prerequisite.
  developer="$(xcode-select -p 2> /dev/null)" || return 0
  cxx_path="$(command -v clang++ 2> /dev/null)" || cxx_path=""
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2> /dev/null && pwd)" || return 0

  sdk_path="$(xcrun --show-sdk-path 2> /dev/null)" || sdk_path=""
  sdk_version="$(xcrun --show-sdk-version 2> /dev/null)" || sdk_version=""
  cc_stamp="$(stat -f %m "$(dirname "$cc_path")" 2> /dev/null)" || cc_stamp=""
  cxx_stamp=""
  if [ -n "$cxx_path" ]; then
    cxx_stamp="$(stat -f %m "$(dirname "$cxx_path")" 2> /dev/null)" || cxx_stamp=""
  fi
  key="capnp-wasm-toolchain-env-1|$(uname -r 2> /dev/null)|$sdk_path|$sdk_version"
  key="$key|$cc_path|$cc_stamp|$cxx_path|$cxx_stamp"
  cache_dir="$root/build/toolchain-env"
  cache_file="$cache_dir/native-link"

  mode=""
  value=""
  if [ -r "$cache_file" ]; then
    cached_key=""
    cached_mode=""
    cached_value=""
    {
      IFS= read -r cached_key || true
      IFS= read -r cached_mode || true
      IFS= read -r cached_value || true
    } < "$cache_file"
    if [ "$cached_key" = "$key" ]; then
      case "$cached_mode" in
        default | none) mode="$cached_mode" ;;
        sdkroot) if [ -d "$cached_value" ]; then mode=sdkroot; value="$cached_value"; fi ;;
        ld) if [ -x "$cached_value" ]; then mode=ld; value="$cached_value"; fi ;;
      esac
    fi
  fi

  if [ -z "$mode" ]; then
    mkdir -p "$cache_dir" 2> /dev/null || true
    work="$(mktemp -d "$cache_dir/probe.XXXXXX" 2> /dev/null)" ||
      work="$(mktemp -d 2> /dev/null)" || return 0
    printf '#include <stdio.h>\nint main(void) { puts("ok"); return 0; }\n' > "$work/probe.c"
    printf '#include <cstdio>\nint main() { std::puts("ok"); }\n' > "$work/probe.cpp"
    mode=none
    if capnp_wasm_toolchain_links "$work" ""; then
      mode=default
    else
      sdk_real=""
      if [ -n "$sdk_path" ]; then
        sdk_real="$(cd "$sdk_path" 2> /dev/null && pwd -P)" || sdk_real=""
      fi
      while IFS= read -r candidate; do
        [ -n "$candidate" ] || continue
        if capnp_wasm_toolchain_links "$work" "SDKROOT=$candidate"; then
          mode=sdkroot
          value="$candidate"
          break
        fi
      done <<CANDIDATES
$(capnp_wasm_toolchain_sdks "$sdk_real" "$developer")
CANDIDATES
      if [ "$mode" = none ]; then
        ld="$(xcrun -f ld 2> /dev/null)" || ld=""
        if [ -n "$ld" ] && [ -x "$ld" ] &&
          capnp_wasm_toolchain_links "$work" "" "-fuse-ld=$ld"; then
          mode=ld
          value="$ld"
        fi
      fi
    fi
    rm -rf "$work"
    if printf '%s\n%s\n%s\n' "$key" "$mode" "$value" > "$cache_dir/native-link.$$" 2> /dev/null; then
      mv -f "$cache_dir/native-link.$$" "$cache_file" 2> /dev/null ||
        rm -f "$cache_dir/native-link.$$"
    fi
    line="capnp-wasm: the pinned clang cannot link against the default macOS SDK"
    line="$line ${sdk_version:-?} (${sdk_path:-no SDK});"
    case "$mode" in
      sdkroot) echo "$line exporting SDKROOT=$value (cached in build/toolchain-env)" >&2 ;;
      ld) echo "$line exporting LDFLAGS=-fuse-ld=$value and Cargo host rustflags (cached in build/toolchain-env)" >&2 ;;
      none) echo "$line no installed SDK or Xcode linker works either. Native builds will fail; run 'mise run doctor'." >&2 ;;
    esac
  fi

  case "$mode" in
    sdkroot)
      export SDKROOT="$value"
      ;;
    ld)
      export LDFLAGS="-fuse-ld=$value${LDFLAGS:+ $LDFLAGS}"
      case "$(uname -m 2> /dev/null)" in
        arm64 | aarch64) triple=AARCH64_APPLE_DARWIN ;;
        x86_64) triple=X86_64_APPLE_DARWIN ;;
        *) triple="" ;;
      esac
      if [ -n "$triple" ]; then
        eval "existing=\${CARGO_TARGET_${triple}_RUSTFLAGS:-}"
        export "CARGO_TARGET_${triple}_RUSTFLAGS=-C link-arg=-fuse-ld=$value${existing:+ $existing}"
      fi
      ;;
  esac
  return 0
}

capnp_wasm_toolchain_env
unset -f capnp_wasm_toolchain_env capnp_wasm_toolchain_sdks capnp_wasm_toolchain_links
