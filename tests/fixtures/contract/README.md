# SDK contract fixtures

`limits.json` pins the resource defaults that both SDKs test.
`typescript-api.d.ts` pins the formatted declarations shipped by the TypeScript
bundle. `go-api.txt` pins `go doc -all` for the Go module, including public
fields, constants, methods, and documentation. These API snapshots use the
repository's pinned Deno and Go printers.

`mise run test:sdk-api` builds the shipped bundle and compares both public APIs
with the reviewed baseline. CI runs it through `mise run test`. Differences
require review under [API stability](../../../docs/api-stability.md) and the
[SDK contract](../../../docs/sdk-contract.md), with a changelog entry when the
interface changes. After that review, `mise run test:sdk-api -- --write` updates
the snapshots. A printer or documentation change may need a baseline update
without changing the interface; inspect the complete diff first.

The baseline records the proposed `0.1.0` interface. It does not authorize
publication or relax the scheduled nightly gate.
