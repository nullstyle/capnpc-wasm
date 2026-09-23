# Zig synchronization history

The Zig generator and runtime now build from the pristine `ref/capnp-zig`
revision. The former eight compatibility patches and three copied reflection
source files have been incorporated into capnp-zig and removed from this
repository. `generators/zig/sync.json` verifies the complete exported source
tree and mirrored conformance fixtures against the native commit.

Those changes covered workspace imports and generated-name collisions, canonical
double-far list writing, lossless binary schema reflection, generated Builder
and generic views, typed generic RPC, streaming, and bounded reflection
allocation and copying. Their original patches remain available in Git history
before the reference advance. Current behavior is documented in the
[Zig generator guide](../../generators/zig/README.md).

The old audit revision is separately recorded in
[`historical-reference`](../../generators/zig/historical-reference). Setup
fetches that exact commit, and `build:zig` exports its sources into
`build/src/capnp-zig-historical` without changing the live reference checkout.
The wire probes compile against that historical runtime and retain the original
Layout A rejection and traversal-budget regression controls; the historical
`capnpc-zig-upstream` command is no longer built, because no test consumed it.
This prevents a reference advance from silently erasing evidence of the fixes.

All production generation and generated-code consumers use the current native
and WASI builds. Their output must match byte for byte, and the generated-code
consumers and independent C++ wire oracle must pass. No Zig porting patch is
currently needed.
