# Wazero command test host

This development runner executes WASI Preview 1 commands against the exact
`ref/wazero` gitlink. Its module replacement is intentional: the requirement's
version identifies the module, while the submodule selects the source tested.
Standardized Wasm exception handling is enabled explicitly because the pinned
Cap'n Proto requires C++ exceptions. Each invocation creates a fresh runtime.

Run from the repository root so mise's project toolchain and caches apply:

```sh
mise run build:wasm
mise run build:wazero
mkdir -p build/host-empty
mise exec -- build/hosts/wazero-run --dir build/host-empty::/ build/wasm/bin/capnp.wasm id
mise exec -- build/hosts/wazero-run --interpreter --dir build/host-empty::/ build/wasm/bin/capnp.wasm id
```

Arguments after the module path go to the command. Stdin, stdout, and stderr are
inherited. Host environment variables and directories are not inherited. Use
repeatable `--dir host::guest` options to grant directories; for example,
`--dir build/compiler-root::/`. Directory grants are writable, so use disposable
staging directories when running generators. This is a test runner, not a host
SDK or a publication mechanism.
