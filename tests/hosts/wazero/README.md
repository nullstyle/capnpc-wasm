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

Arguments after the module path go to the command. The guest's `argv[0]` is the
module file name without `.wasm` (`capnp`, `capnpc-c++`, ...), as the SDKs and
the launcher pass it, so diagnostics never contain the host path. Stdin, stdout,
and stderr are inherited; stdin is presented to the guest as a plain stream, so
a redirected regular file behaves like a pipe. Host environment variables and
directories are not inherited. Use repeatable `--dir host::guest` options to
grant directories; for example, `--dir build/compiler-root::/`. Directory grants
are writable, so use disposable staging directories when running generators.
This is a test runner, not a host SDK or a publication mechanism.

## Exit status

The runner distinguishes a guest diagnostic from a runtime failure, which the
parity tests rely on:

| Status  | Meaning                                                                 |
| ------- | ----------------------------------------------------------------------- |
| guest's | The guest called `proc_exit`; the status passes through unchanged.      |
| 2       | Usage error in the runner's own arguments.                              |
| 70      | A trap, an uncaught guest exception, or a host failure such as an       |
|         | unreadable module; `wazero-run:` and the engine's message go to stderr. |

The command modules exit 0 or 1, so 70 cannot be mistaken for one of their own
statuses. Wasm DWARF debug info is not loaded; the shipped modules carry sysroot
debug sections that wazero would otherwise walk on every guest exit.
