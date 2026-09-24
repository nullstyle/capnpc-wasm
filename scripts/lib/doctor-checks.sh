#!/usr/bin/env bash
# shellcheck shell=bash
#
# Doctor checks as functions over explicit inputs, so scripts/doctor.sh can
# run them against the repository and a test can run them against a broken
# input without touching the repository. Each function prints one line
# describing the problem and returns 1, or prints nothing and returns 0.
# Sourced; the caller sets `set -euo pipefail`.

version_ge() {
  # usage: version_ge <a> <b>: numeric dotted comparison, true when a >= b.
  local a b i
  IFS=. read -ra a <<< "$1"
  IFS=. read -ra b <<< "$2"
  for ((i = 0; i < ${#b[@]}; i++)); do
    if ((${a[i]:-0} > ${b[i]:-0})); then return 0; fi
    if ((${a[i]:-0} < ${b[i]:-0})); then return 1; fi
  done
  return 0
}

check_mise_version() {
  # usage: check_mise_version <installed version> <minimum version>
  local installed="${1%% *}" minimum="$2"
  case "$installed$minimum" in *[!0-9.]* | "") echo "cannot parse mise version '$1' against minimum '$2'"; return 1 ;; esac
  if ! version_ge "$installed" "$minimum"; then
    echo "mise $installed is older than the mise.toml minimum $minimum"
    return 1
  fi
}

check_tool_version() {
  # usage: check_tool_version <tool> <pinned version> <reported version text>
  local tool="$1" pin="$2" reported="$3"
  if [[ -z "$pin" ]]; then
    echo "$tool has no pin in mise.toml"
    return 1
  fi
  if [[ -z "$reported" ]]; then
    echo "$tool is not on PATH"
    return 1
  fi
  # The pin must appear as a whole version token: 1.27.10 is not 1.27.1,
  # and neither is 1.27.1-nightly or a longer commit suffix. Real banners
  # end the version with a space, a parenthesis, or the end of the line.
  if [[ " $reported " != *[!0-9.]"$pin"[!0-9A-Za-z.+-]* ]]; then
    echo "$tool on PATH reports '$reported' but the pin is $pin"
    return 1
  fi
}

check_zig_pin() {
  # usage: check_zig_pin <pinned zig version> <reference mise.toml>
  local pin="$1" file="$2" upstream
  upstream="$(sed -n 's/^zig = "\(.*\)"$/\1/p' "$file" 2> /dev/null | head -n 1)"
  if [[ -z "$upstream" ]]; then
    echo "no zig pin found in $file"
    return 1
  fi
  if [[ "$upstream" != "$pin" ]]; then
    echo "mise.toml pins zig $pin but $file pins $upstream"
    return 1
  fi
}

check_wasi_sdk_pin() {
  # usage: check_wasi_sdk_pin <pinned wasi-sdk version> <reference dir>
  local pin="$1" dir="$2" tag
  if ! tag="$(git -C "$dir" describe --tags --exact-match HEAD 2> /dev/null)"; then
    echo "$dir is not at a tagged release (fetch tags, then run mise run refs:sync)"
    return 1
  fi
  if [[ "$tag" != "wasi-sdk-$pin" ]]; then
    echo "mise.toml pins wasi-sdk $pin but $dir is at tag $tag"
    return 1
  fi
}

check_wazero_pin() {
  # usage: check_wazero_pin <gitlink> <sdk go.mod> <host go.mod> <reference dir>
  local gitlink="$1" sdk_mod="$2" host_mod="$3" dir="$4" version suffix tagged replace
  version="$(awk '$1 == "require" && $2 == "github.com/tetratelabs/wazero" { print $3 }
                  $1 == "github.com/tetratelabs/wazero" { print $2 }' "$sdk_mod" 2> /dev/null | head -n 1)"
  if [[ -z "$version" ]]; then
    echo "$sdk_mod does not require github.com/tetratelabs/wazero"
    return 1
  fi
  suffix="${version##*-}"
  if [[ "$suffix" =~ ^[0-9a-f]{12}$ ]]; then
    if [[ "$gitlink" != "$suffix"* ]]; then
      echo "$sdk_mod pins wazero $version but the ref/wazero gitlink is $gitlink"
      return 1
    fi
  else
    tagged="$(git -C "$dir" rev-parse --verify --quiet "refs/tags/$version^{commit}" 2> /dev/null || true)"
    if [[ "$tagged" != "$gitlink" ]]; then
      echo "$sdk_mod pins wazero $version, which is not the ref/wazero gitlink $gitlink"
      return 1
    fi
  fi
  replace="$(awk '$1 == "replace" && $2 == "github.com/tetratelabs/wazero" && $3 == "=>" { print $4 }' "$host_mod" 2> /dev/null | head -n 1)"
  if [[ "$replace" != "../../../ref/wazero" ]]; then
    echo "$host_mod must replace github.com/tetratelabs/wazero with ../../../ref/wazero (found '${replace:-none}')"
    return 1
  fi
}

check_historical_commit() {
  # usage: check_historical_commit <reference dir> <historical-reference file>
  local dir="$1" file="$2" revision
  revision="$(cat "$file" 2> /dev/null || true)"
  if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
    echo "$file does not contain a commit id"
    return 1
  fi
  if ! git -C "$dir" cat-file -e "$revision^{commit}" 2> /dev/null; then
    echo "$dir does not contain the historical commit $revision; run mise run refs:sync"
    return 1
  fi
}

check_linux_prerequisites() {
  # usage: check_linux_prerequisites: a GCC 14 or newer C++ toolchain (headers
  # for the pinned clang) and pkg-config, as CI installs on ubuntu-24.04.
  local candidate found="" major
  for candidate in g++-14 g++-15 g++-16 g++; do
    if command -v "$candidate" > /dev/null 2>&1; then
      major="$("$candidate" -dumpfullversion -dumpversion 2> /dev/null | cut -d. -f1)"
      if [[ "$major" =~ ^[0-9]+$ ]] && ((major >= 14)); then
        found="$candidate"
        break
      fi
    fi
  done
  if [[ -z "$found" ]]; then
    echo "no g++ 14 or newer on PATH (CI installs g++-14: sudo apt-get install g++-14 pkg-config)"
    return 1
  fi
  if ! command -v pkg-config > /dev/null 2>&1; then
    echo "pkg-config is not on PATH (sudo apt-get install pkg-config)"
    return 1
  fi
}

check_macos_sdk() {
  # usage: check_macos_sdk <SDKROOT or empty>: the SDK in use must exist.
  local sdk="$1"
  if [[ -z "$sdk" ]]; then
    if ! sdk="$(xcrun --show-sdk-path 2> /dev/null)"; then
      echo "xcrun finds no macOS SDK; install the Xcode Command Line Tools (xcode-select --install)"
      return 1
    fi
  fi
  if [[ ! -f "$sdk/SDKSettings.plist" ]]; then
    echo "macOS SDK path $sdk is not an SDK"
    return 1
  fi
}
