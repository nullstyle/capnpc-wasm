#!/usr/bin/env bash
# Check that the pinned tools, host prerequisites, and references can build
# this repository. One PASS or FAIL line per check, with a remediation hint on
# failure; --verbose adds the tool version banners and reference status.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/refs.sh
source scripts/lib/refs.sh
# shellcheck source=scripts/lib/doctor-checks.sh
source scripts/lib/doctor-checks.sh

verbose=0
for arg in "$@"; do
  case "$arg" in
    -v | --verbose) verbose=1 ;;
    *)
      echo "usage: scripts/doctor.sh [--verbose]" >&2
      exit 2
      ;;
  esac
done

failures=0
pass() {
  printf 'PASS %s\n' "$1"
}
fail() {
  # usage: fail <summary> [detail lines...]
  local detail
  printf 'FAIL %s\n' "$1" >&2
  shift
  for detail in "$@"; do
    printf '     %s\n' "$detail" >&2
  done
  failures=$((failures + 1))
}
check() {
  # usage: check <label> <hint> <function> [args...]: the function's output
  # is the reason shown on failure.
  local label="$1" hint="$2" reason
  shift 2
  if reason="$("$@" 2>&1)"; then
    pass "$label"
  else
    fail "$label" "$reason" "$hint"
  fi
}
note() {
  printf '     %s\n' "$1"
}
banner() {
  # usage: banner <command...>: shown only with --verbose.
  if [[ "$verbose" -eq 1 ]]; then
    "$@" 2>&1 | sed 's/^/     /' || true
  fi
}

# mise itself and the pinned tools.
mise_version="$(mise --version 2> /dev/null | head -n 1)"
min_version="$(sed -n 's/^min_version = "\(.*\)"$/\1/p' mise.toml | head -n 1)"
check "mise ${mise_version%% *} meets the minimum $min_version" \
  "upgrade mise (https://mise.jdx.dev/getting-started.html)" \
  check_mise_version "$mise_version" "$min_version"
banner mise ls --current

# mise merges the global configuration into this listing, so a tool pinned
# only in ~/.config/mise also shows up here.
missing="$(mise ls --current --missing 2> /dev/null || true)"
if [[ -n "$missing" ]]; then
  fail "tools required by the mise configuration are installed" "$missing" \
    "run mise install (the list includes tools pinned by your global mise config)"
else
  pass "tools required by the mise configuration are installed"
fi

# Each pinned tool on PATH must report its pinned version; otherwise a system
# or Homebrew binary shadows the pin (mise falls back silently).
current="$(mise current 2> /dev/null || true)"
tool_checks=(
  "clang|clang --version"
  "conda:clangxx|clang++ --version"
  "cmake|cmake --version"
  "ninja|ninja --version"
  "go|go version"
  "deno|deno --version"
  "zig|zig version"
  "wasm-tools|wasm-tools --version"
  "wasmtime|wasmtime --version"
  "shellcheck|shellcheck --version"
  "aqua:rhysd/actionlint|actionlint -version"
  "rust|rustc --version"
)
for entry in "${tool_checks[@]}"; do
  tool="${entry%%|*}"
  read -ra command <<< "${entry#*|}"
  pin="$(printf '%s\n' "$current" | awk -v tool="$tool" '$1 == tool { print $2 }')"
  reported="$("${command[@]}" 2>&1 | tr '\n' ' ' || true)"
  location="$(command -v "${command[0]}" 2> /dev/null || echo "not on PATH")"
  check "$tool $pin on PATH ($location)" \
    "run mise install, or fix PATH ordering so the pinned binary comes first" \
    check_tool_version "$tool" "$pin" "$reported"
  banner "${command[@]}"
done
check "cargo on PATH ($(command -v cargo 2> /dev/null || echo "not on PATH"))" \
  "run mise install" command -v cargo

# WASI SDK layout and its pin against the reference tag.
sdk_path="$(mise where wasi-sdk 2> /dev/null || true)"
wasi_sdk_layout() {
  [[ -n "$sdk_path" ]] || { echo "mise where wasi-sdk failed"; return 1; }
  [[ -x "$sdk_path/bin/clang" && -x "$sdk_path/bin/clang++" ]] || { echo "no clang/clang++ under $sdk_path/bin"; return 1; }
  [[ -d "$sdk_path/share/wasi-sysroot" ]] || { echo "no wasi-sysroot under $sdk_path/share"; return 1; }
  [[ -f "$sdk_path/share/cmake/wasi-sdk-p1.cmake" ]] || { echo "no wasi-sdk-p1.cmake under $sdk_path/share/cmake"; return 1; }
}
check "WASI SDK layout at $sdk_path" "run mise install" wasi_sdk_layout
check "WASI SDK pin matches the ref/wasi-sdk tag" \
  "align the wasi-sdk pin in mise.toml with the ref/wasi-sdk gitlink" \
  check_wasi_sdk_pin "$(mise current wasi-sdk 2> /dev/null || true)" ref/wasi-sdk
if [[ -n "$sdk_path" ]]; then banner "$sdk_path/bin/clang" --version; fi

rust_wasi_libdir="$(rustc --print target-libdir --target wasm32-wasip1 2> /dev/null || true)"
rust_wasi_stdlib() {
  compgen -G "$rust_wasi_libdir/libstd-*.rlib" > /dev/null || {
    echo "no libstd for wasm32-wasip1 under ${rust_wasi_libdir:-?}"
    return 1
  }
}
check "Rust wasm32-wasip1 standard library" "run mise install" rust_wasi_stdlib

# Host prerequisites and the native link. Version banners cannot show that the
# pinned linker rejects the host SDK; only compiling, linking, and running a
# program can. scripts/lib/toolchain-env.sh exports SDKROOT or LDFLAGS when it
# has to; the builds link through LDFLAGS (clang) and Cargo's host rustflags
# (rustc), and neither compiler reads those variables itself.
if [[ "$(uname -s)" == Darwin ]]; then
  native_sdk="${SDKROOT:-$(xcrun --show-sdk-path 2> /dev/null || echo "none found")}"
  native_sdk_version="unknown version"
  if [[ -f "$native_sdk/SDKSettings.plist" ]]; then
    native_sdk_version="$(plutil -extract Version raw "$native_sdk/SDKSettings.plist" 2> /dev/null || echo "unknown version")"
  fi
  check "macOS SDK: $native_sdk ($native_sdk_version${SDKROOT:+, from SDKROOT})" \
    "install the Xcode Command Line Tools, or point SDKROOT at an installed SDK" \
    check_macos_sdk "${SDKROOT:-}"
elif [[ "$(uname -s)" == Linux ]]; then
  check "Linux host development packages (g++ 14 or newer, pkg-config)" \
    "sudo apt-get install -y g++-14 pkg-config" check_linux_prerequisites
fi
native_linker="$(cc -print-prog-name=ld 2> /dev/null || echo ld)"
native_linker_version="$("$native_linker" -v 2>&1 < /dev/null | head -n 1 || true)"
note "native linker: $native_linker${native_linker_version:+ ($native_linker_version)}"
if [[ -n "${LDFLAGS:-}" ]]; then
  note "LDFLAGS: $LDFLAGS"
fi
read -ra ldflags <<< "${LDFLAGS:-}"
rustc_link_args=()
for flag in ${ldflags[@]+"${ldflags[@]}"}; do
  rustc_link_args+=(-C "link-arg=$flag")
done

mkdir -p build
probe_dir="$(mktemp -d build/doctor.XXXXXX)"
trap 'rm -rf "$probe_dir"' EXIT
printf '#include <stdio.h>\nint main(void) { puts("hello"); return 0; }\n' > "$probe_dir/hello.c"
printf '#include <cstdio>\nint main() { std::puts("hello"); }\n' > "$probe_dir/hello.cpp"
printf 'fn main() { println!("hello"); }\n' > "$probe_dir/hello.rs"

run_native() { "$1"; }
run_wasi() { wasmtime run "$1"; }
link_probe() {
  # usage: link_probe <name> <runner> <compile command...>; the command must
  # write $probe_dir/<name>, which the runner executes and must print "hello".
  local name="$1" runner="$2" output
  shift 2
  if "$@" > "$probe_dir/$name.log" 2>&1 &&
     output="$("$runner" "$probe_dir/$name" 2>> "$probe_dir/$name.log")" &&
     [[ "$output" == hello ]]; then
    pass "$name compiles, links, and runs"
  else
    fail "$name cannot compile, link, or run a hello program:" \
      "$(head -n 6 "$probe_dir/$name.log" 2> /dev/null || true)" \
      "hint: set SDKROOT to an SDK the pinned linker accepts, or LDFLAGS=-fuse-ld=<linker> (see scripts/lib/toolchain-env.sh)"
  fi
}
link_probe cc run_native cc ${ldflags[@]+"${ldflags[@]}"} \
  -o "$probe_dir/cc" "$probe_dir/hello.c"
link_probe clang++ run_native clang++ -std=c++23 ${ldflags[@]+"${ldflags[@]}"} \
  -o "$probe_dir/clang++" "$probe_dir/hello.cpp"
link_probe rustc run_native rustc ${rustc_link_args[@]+"${rustc_link_args[@]}"} \
  -o "$probe_dir/rustc" "$probe_dir/hello.rs"
if [[ -n "$sdk_path" ]]; then
  link_probe wasi-clang run_wasi "$sdk_path/bin/clang" --target=wasm32-wasip1 \
    -o "$probe_dir/wasi-clang" "$probe_dir/hello.c"
fi

# References: initialized, at the recorded gitlink, and without local changes.
reference_ok() {
  local problem
  problem="$(ref_checkout_problem "$1")"
  [[ -z "$problem" ]] || { echo "$problem"; return 1; }
}
while read -r _ path; do
  name="${path#ref/}"
  check "reference $path is at its recorded commit and clean" \
    "run mise run refs:sync, or restore the checkout" reference_ok "$name"
done < <(git config -f .gitmodules --get-regexp '\.path$')
banner git submodule status

# Pins recorded in more than one place must agree.
check "Zig pin matches ref/capnp-zig/mise.toml" \
  "align the zig pin in mise.toml with the reference (see README: Tools)" \
  check_zig_pin "$(mise current zig 2> /dev/null || true)" ref/capnp-zig/mise.toml
check "wazero pins in sdk/go and tests/hosts/wazero match the ref/wazero gitlink" \
  "update sdk/go/go.mod to the pseudo-version at the gitlink and keep the replace in tests/hosts/wazero/go.mod" \
  check_wazero_pin "$(ref_revision wazero)" sdk/go/go.mod tests/hosts/wazero/go.mod ref/wazero
check "historical capnp-zig commit is present in ref/capnp-zig" \
  "run mise run refs:sync" \
  check_historical_commit ref/capnp-zig generators/zig/historical-reference

if [[ "$failures" -ne 0 ]]; then
  echo "Doctor found $failures problem(s)." >&2
  exit 1
fi
echo "Toolchain and reference checks passed."
