# Failure and limit conformance corpus

One list of failing and budget-breaching inputs that every host surface runs,
and one table of the outcome each surface must produce. The corpus makes the
error model a cross-surface fact: a consumer who moves between the TypeScript
SDK, the Go SDK, the packaged launcher, a browser, and Schema Studio sees the
same classification for the same input, or a divergence this table records with
its reason.

| File            | Contents                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `cases.json`    | The materialized cases: inputs, generators, guests, limits, deadlines, and a workspace digest per compile case. Generated from `cases.ts`.   |
| `guests/*.wat`  | The guest sources: WASI commands that trap, recurse, flood a stream, publish hostile names, grow memory, warn, or loop.                      |
| `guests.json`   | The guests assembled with the pinned `wasm-tools` (`parse`, then `strip --all`), hex by name, for runners that cannot spawn `wasm-tools`.    |
| `expected.json` | The outcome per case, the departures per surface with a reason and a finding, and the cases a surface cannot express with the reason for it. |

The source of the cases is
[`tests/conformance/cases.ts`](../../conformance/cases.ts); the classification
and the expectation checks are in
[`tests/conformance/outcome.ts`](../../conformance/outcome.ts). Regenerate the
JSON after editing a source:

```sh
mise exec -- deno run --allow-read --allow-write=tests/fixtures/conformance tests/conformance/cases.ts --write
mise exec -- deno run --allow-read --allow-write=tests/fixtures/conformance,build --allow-run=wasm-tools tests/conformance/guests.ts --write
```

`mise run test:conformance` fails when either file no longer matches its source,
when `expected.json` lacks a case or a reason, and when the reference surface
(the TypeScript SDK in direct execution on the pinned Deno) departs from the
table.

## Outcomes

| Outcome              | Meaning                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `ok`                 | The job succeeded; `outputs` counts files per language and `diagnostics` the retained stderr entries.  |
| `validation[:limit]` | Caller input was rejected before any guest started; a budget names the limit (`validation:pathBytes`). |
| `exit(n)`            | A guest exited with status `n`.                                                                        |
| `trap`               | A guest trapped: `unreachable`, a memory fault.                                                        |
| `trap:stack`         | A guest exhausted the call stack, whatever the runtime calls it.                                       |
| `limit:<budget>`     | A running guest exceeded a `ResourceLimits` budget; the failing stage is recorded.                     |
| `policy:<rule>`      | The host refused a result by policy (`policy:output-name` for a backslash in a generated file name).   |
| `protocol`           | A guest exited 0 without honoring its contract (an empty request, a generator that wrote to stdout).   |
| `timeout`            | The host deadline stopped the job.                                                                     |

Every TypeScript surface classifies from the error class, message, and cause
chain, as [the SDK contract](../../../docs/sdk-contract.md#errors) describes
them today; when `CompileError` gains `kind` and `limit`, the classifier reads
those fields and the table stays as it is. The Go runner derives the same words
from `Error.Limit`, `Error.ExitCode`, the `validate` and `modules` stages, the
contract messages, and wazero's trap text. The launcher runner reads the exit
status and Wasmtime's trap text (`call stack exhausted`, `interrupt`).

## Surfaces

| Surface          | Runner                                                                 | Task                              |
| ---------------- | ---------------------------------------------------------------------- | --------------------------------- |
| `ts-direct`      | `sdk/typescript/conformance_test.ts`, `tests/conformance`              | `test:sdk-ts`, `test:conformance` |
| `ts-worker`      | `sdk/typescript/conformance_test.ts` on the supported worker runtime   | `test:deno-worker`                |
| `go`             | `sdk/go/conformance_test.go`                                           | `test:sdk-go`                     |
| `launcher`       | `tests/package/launcher.ts`                                            | `test:launcher`, `test:package`   |
| `browser-direct` | `tests/browser/test.ts`, `createCompiler` in each engine               | `test:browser`                    |
| `browser-worker` | `tests/browser/test.ts`, `createWorkerCompiler` in each engine         | `test:browser`                    |
| `studio`         | `tests/browser/test.ts`, `examples/browser/compiler.js` in each engine | `test:browser`                    |

Each runner produces the "valid" generation request by compiling the same
one-struct schema on its own surface; the malformed variants (`half`, `one`,
`zeros8`, `pattern4k`) derive from it identically. Deadline rows run only where
the surface has a deadline (`timeoutMs`, a `context` deadline,
`CAPNP_WASM_TIMEOUT`, or the adapter's abort signal).

## Depth rows

The recursion a compile needs grows with const-reference and import chains, and
the ceiling depends on the engine's stack and even on the thread (GAP3-02):
about 179 const references on wazero's interpreter, 267 in a Chromium worker,
486 on Chromium's main thread, 555 on Deno, and about 2,700 under the launcher's
8 MiB Wasm stack. The corpus pins a depth every surface must compile
(`const-chain-100`, `import-chain-100`) and a chain no stack holds
(`const-chain-4000`). Which stack ends first differs: V8 reports its own stack
(`trap:stack`), while Wasmtime's 8 MiB call stack outlives the guest's 8 MiB
linear-memory stack, which then faults (`trap`). `compiler-stack-overflow` and
`generator-stack-overflow` use a synthetic recursion guest so that the stack
kind itself is pinned on every surface.

## Divergences

Every departure in `expected.json` carries a `reason` and a `finding`, and every
case a surface cannot express carries a `skip` reason. The departures as
recorded:

| Case                                               | Surface    | Departure                                                                                            |
| -------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| `missing-import-root`, `missing-source-prefix`     | `launcher` | `exit(1)`: the launcher passes the arguments through and the compiler reports the missing directory. |
| `const-chain-4000`                                 | `launcher` | `trap`: the guest's linear-memory stack faults before Wasmtime's call stack ends.                    |
| `const-chain-4000`                                 | browsers   | `trap:stack` or `trap`: which stack ends first depends on the engine's thread stack.                 |
| `generator-bad-name`                               | `go`       | `exit(70)`: the memory filesystem refuses the name at creation with `EPERM`, and the guest exits.    |
| `generator-bad-name`                               | `launcher` | `ok`, one file: the launcher applies no output-name policy, and the host filesystem accepts `a\b`.   |
| `generator-stderr-flood`, `generator-stdout-flood` | `launcher` | `ok`: the launcher has no stream budgets; the streams pass through to the caller.                    |
| `generator-many-files`, `generator-big-file`       | `launcher` | `ok`: the launcher has no output budgets; 5,000 files and a 65 MiB file are published.               |

Cases a surface skips: the budget rows and `generator-long-name` on the launcher
(no configurable budgets) and in Studio (fixed budgets); the custom guests in
Studio (bundled modules only); the import-root and source-prefix rows in Studio
(the adapter sets neither); the 4,096- and 4,097-byte paths on the launcher (the
host filesystem cannot stage them); and the deadline rows in direct execution
(no deadline).
