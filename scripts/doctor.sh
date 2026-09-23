#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

status=0
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
  status=1
}

mise ls --current
clang --version
clang++ --version
cmake --version
ninja --version
rustc --version
cargo --version
go version
deno --version
zig version
wasm-tools --version
read -r _ wasm_tools_version _ <<< "$(wasm-tools --version)"
if [[ "$wasm_tools_version" != "$(mise current wasm-tools)" ]]; then
  echo "wasm-tools on PATH differs from the mise pin; check tool ordering." >&2
  exit 1
fi
wasmtime --version
shellcheck --version

sdk_path="$(mise where wasi-sdk)"
if [[ ! -x "$sdk_path/bin/clang" || ! -x "$sdk_path/bin/clang++" ||
      ! -d "$sdk_path/share/wasi-sysroot" ||
      ! -f "$sdk_path/share/cmake/wasi-sdk-p1.cmake" ]]; then
  echo "Incomplete WASI SDK installation at $sdk_path; run mise install." >&2
  exit 1
fi
"$sdk_path/bin/clang" --version

rust_wasi_libdir="$(rustc --print target-libdir --target wasm32-wasip1)"
if ! compgen -G "$rust_wasi_libdir/libstd-*.rlib" > /dev/null; then
  echo "Missing Rust wasm32-wasip1 standard library; run mise install." >&2
  exit 1
fi

# Native link probes. Version banners cannot show that the pinned linker
# rejects the host SDK; only compiling, linking, and running a program can.
# scripts/lib/toolchain-env.sh exports SDKROOT or LDFLAGS when it has to.
if [[ "$(uname -s)" == Darwin ]]; then
  native_sdk="${SDKROOT:-$(xcrun --show-sdk-path 2> /dev/null || echo "none found")}"
  native_sdk_version="unknown version"
  if [[ -f "$native_sdk/SDKSettings.plist" ]]; then
    native_sdk_version="$(plutil -extract Version raw "$native_sdk/SDKSettings.plist" 2> /dev/null || echo "unknown version")"
  fi
  echo "native SDK: $native_sdk ($native_sdk_version${SDKROOT:+, from SDKROOT})"
else
  echo "native SDK: system default"
fi
native_linker="$(cc -print-prog-name=ld)"
native_linker_version="$("$native_linker" -v 2>&1 < /dev/null | head -n 1 || true)"
echo "native linker: $native_linker${native_linker_version:+ ($native_linker_version)}"
if [[ -n "${LDFLAGS:-}" ]]; then
  echo "LDFLAGS: $LDFLAGS"
fi

mkdir -p build
probe_dir="$(mktemp -d build/doctor.XXXXXX)"
trap 'rm -rf "$probe_dir"' EXIT
printf '#include <stdio.h>\nint main(void) { puts("hello"); return 0; }\n' > "$probe_dir/hello.c"
printf '#include <cstdio>\nint main() { std::puts("hello"); }\n' > "$probe_dir/hello.cpp"
printf 'fn main() { println!("hello"); }\n' > "$probe_dir/hello.rs"

# The builds link through LDFLAGS (clang) and Cargo's host rustflags (rustc);
# neither compiler reads those variables itself, so splice them in here.
read -ra ldflags <<< "${LDFLAGS:-}"
rustc_link_args=()
for flag in ${ldflags[@]+"${ldflags[@]}"}; do
  rustc_link_args+=(-C "link-arg=$flag")
done

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
link_probe wasi-clang run_wasi "$sdk_path/bin/clang" --target=wasm32-wasip1 \
  -o "$probe_dir/wasi-clang" "$probe_dir/hello.c"

ref_status="$(git submodule status)"
printf '%s\n' "$ref_status"
if [[ -z "$ref_status" ]] || [[ "$ref_status" =~ (^|$'\n')[-+U] ]]; then
  echo "References are missing or differ from their recorded commits; run mise run refs:sync." >&2
  exit 1
fi

if [[ "$status" -ne 0 ]]; then
  echo "Toolchain checks failed." >&2
  exit 1
fi
echo "Toolchain and reference checks passed."
