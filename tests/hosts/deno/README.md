# Deno browser-shim test host

This development runner loads the exact `ref/browser_wasi_shim` source into
Deno. `--unstable-sloppy-imports` resolves that upstream source's `.js` imports
to its `.ts` files; it is a development convenience, not a package API. The
adapter disables upstream debug output to keep stdout binary and corrects
`args_sizes_get` to count UTF-8 bytes for non-ASCII arguments. The reference
source remains unchanged.

Run from the repository root:

```sh
mise run build:wasm
mkdir -p build/host-empty
mise exec -- deno run --unstable-sloppy-imports --allow-read --allow-write \
  tests/hosts/deno/main.ts --dir build/host-empty::/ build/wasm/bin/capnp.wasm id
```

Each invocation creates a fresh Wasm instance and in-memory filesystem. The
guest's `argv[0]` is the module file name without `.wasm` (`capnp`,
`capnpc-c++`, ...), as the SDKs pass it, so diagnostics never contain the host
path. Stdin, stdout, and stderr remain binary; stdin is read to EOF before
execution. The optional single `--dir host::/` loads a trusted staging directory
into guest `/`. Only successful command exits copy created or modified files
back to that directory. The test-only `--export-always` option (before the
module path) bypasses that transactional export and copies the files back after
any exit, so negative-path tests can observe what a failing guest wrote.
Deletions are not exported. Symlinks, special files, and invalid path components
are rejected. Host environment variables are not inherited.

## Exit status

The runner distinguishes a guest diagnostic from a runtime failure, which the
parity tests rely on:

| Status  | Meaning                                                                   |
| ------- | ------------------------------------------------------------------------- |
| guest's | The guest called `proc_exit`; the status passes through unchanged.        |
| 2       | Usage error in the runner's own arguments.                                |
| 70      | A trap, an uncaught guest exception, or a host failure such as an         |
|         | unreadable module or staging directory; `deno-wasi-run:` and the engine's |
|         | message go to stderr.                                                     |

The command modules exit 0 or 1, so 70 cannot be mistaken for one of their own
statuses.

The runner is for disposable test fixtures. It is not a production SDK, and
export is not atomic against concurrent host filesystem modifications. Deno
execution verifies the browser shim's in-memory WASI behavior but does not by
itself verify support in a particular browser.

The local Deno configuration matches the upstream source's non-strict TypeScript
settings. Check the adapter and imported reference together with:

```sh
mise exec -- deno check --config tests/hosts/deno/deno.json \
  --unstable-sloppy-imports tests/hosts/deno/main.ts
```
