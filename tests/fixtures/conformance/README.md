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

Every TypeScript surface classifies from the error class, the phase that threw
(only `validation:memoryPages` may fail in a factory), `CompileError.kind` and
`limit`, and the innermost cause: the engine's or the host's own error, as
[the SDK contract](../../../docs/sdk-contract.md#errors) describes them. It
never reads guest stderr, which the SDK appends to its wrapper messages. Kind
`exit` is `exit(n)`, `limit` is `limit:<budget>`, and `protocol` is `protocol`;
a `trap` is refined by its innermost cause, because no kind expresses
`trap:stack` or `policy:output-name`: a `RuntimeError` is a `trap`, an engine's
stack report is `trap:stack`, and any other cause is `error:<name>`, which
matches no row. A missing or unknown kind, or a limit without its name, is an
`error:CompileError(...)` outcome, which matches no row either. The Go runner
derives the same words from `Error.Limit`, `Error.ExitCode`, the `validate` and
`modules` stages, the contract messages, and wazero's own `wasm error:` report.
The launcher runner reads the exit status and Wasmtime's own report: status 134
is a trap only with a `wasm trap:` line in it (`call stack exhausted`,
`interrupt`). A row can also pin a message fragment (`message`), as the two bare
validation rows do with "is not a directory in files".

## Surfaces

| Surface          | Runner                                                                 | Task                              |
| ---------------- | ---------------------------------------------------------------------- | --------------------------------- |
| `ts-direct`      | `sdk/typescript/conformance_test.ts`, `tests/conformance`              | `test:sdk-ts`, `test:conformance` |
| `ts-worker`      | `sdk/typescript/conformance_test.ts`, `createWorkerCompiler`           | `test:sdk-ts`                     |
| `go`             | `sdk/go/conformance_test.go`                                           | `test:sdk-go`                     |
| `launcher`       | `tests/package/launcher.ts`                                            | `test:launcher`, `test:package`   |
| `browser-direct` | `tests/browser/test.ts`, `createCompiler` in each engine               | `test:browser`                    |
| `browser-worker` | `tests/browser/test.ts`, `createWorkerCompiler` in each engine         | `test:browser`                    |
| `studio`         | `tests/browser/test.ts`, `examples/browser/compiler.js` in each engine | `test:browser`                    |

A `surfaces` key of the form `<surface>@<engine>` (`browser-worker@webkit`)
holds a departure of one browser engine; the browser driver looks for it before
the plain surface key.

Each runner produces the "valid" generation request by compiling the same
one-struct schema on its own surface; the malformed variants (`half`, `one`,
`zeros8`, `pattern4k`) derive from it identically. Deadline rows run only where
the surface has a deadline (`timeoutMs`, a `context` deadline,
`CAPNP_WASM_TIMEOUT`, or the adapter's abort signal).

## Depth rows

The recursion a compile needs grows with const-reference and import chains, and
the ceiling depends on the engine's stack and even on the thread (GAP3-02).
Measured ceilings, in const references and nested imports:

| Surface                               | Const chain | Import chain |
| ------------------------------------- | ----------- | ------------ |
| WebKit 26.6 worker on macOS (Studio)  | about 34    | about 90     |
| wazero interpreter (Go SDK default)   | 179         | 487          |
| Chromium 153 worker (and Studio)      | 275         | 744          |
| Chromium 153 main thread              | 506         | 1,014        |
| WebKit 26.6 main thread               | 552         | 1,014        |
| Deno 2.9.6, direct                    | about 555   | about 1,500  |
| Launcher (Wasmtime, 8 MiB Wasm stack) | about 2,700 |              |

The browser and Go figures were measured on macOS arm64 on 2026-09-24 (the
import chains above about 1,000 end in a compiler exit, not a stack fault); the
Deno and launcher figures come from GAP3-02. The WebKit worker figure is a
single macOS binary search, and outcomes near it vary between runs: in one run
the SDK worker failed `import-chain-100` with `trap:stack` at the compiler while
Studio's worker compiled it with every output. macOS gives secondary threads a
512 KiB stack against 8 MiB for the main thread, and the 552/34 ratio matches.
Linux threads default to 8 MiB: on Linux CI (run 36099823012) WebKit and Firefox
workers compiled `const-chain-100` and `import-chain-100`, and Firefox reported
its own stack (`trap:stack`) for `const-chain-4000` on all three surfaces. The
corpus pins chains every surface must compile, macOS WebKit workers included
(`const-chain-25`, `import-chain-60`), chains every other measured surface
compiles (`const-chain-100`, `import-chain-100`, which `browser-worker@webkit`
and `studio@webkit` may compile with every output or fail as `trap:stack` at the
compiler), and a chain no stack holds (`const-chain-4000`). Which stack ends
first differs: V8 and JavaScriptCore report their own stack (`trap:stack`),
while Wasmtime's 8 MiB call stack outlives the guest's 8 MiB linear-memory
stack, which then faults (`trap`). `compiler-stack-overflow` and
`generator-stack-overflow` use a synthetic recursion guest so that the stack
kind itself is pinned on every surface.

## Divergences

Every departure in `expected.json` carries a `reason` and a `finding`, and every
case a surface cannot express carries a `skip` reason. The departures as
recorded:

| Case                                               | Surface                  | Departure                                                                                                                                             |
| -------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `missing-import-root`, `missing-source-prefix`     | `launcher`               | `exit(1)`: the launcher passes the arguments through and the compiler reports the missing directory.                                                  |
| `const-chain-100`, `import-chain-100`              | WebKit worker and Studio | `ok` with every output, or `trap:stack` at the compiler: the outcome varies near the macOS worker stack limit; Linux measured `ok` (run 36099823012). |
| `const-chain-4000`                                 | `launcher`               | `trap`: the guest's linear-memory stack faults before Wasmtime's call stack ends.                                                                     |
| `generator-bad-name`                               | `go`                     | `exit(70)`: the memory filesystem refuses the name at creation with `EPERM`, and the guest exits.                                                     |
| `generator-bad-name`                               | `launcher`               | `ok`, one file: the launcher applies no output-name policy, and the host filesystem accepts `a\b`.                                                    |
| `generator-stderr-flood`, `generator-stdout-flood` | `launcher`               | `ok`: the launcher has no stream budgets; the streams pass through to the caller.                                                                     |
| `generator-many-files`, `generator-big-file`       | `launcher`               | `ok`: the launcher has no output budgets; 5,000 files and a 65 MiB file are published.                                                                |

Cases a surface skips: the budget rows and `generator-long-name` on the launcher
(no configurable budgets) and in Studio (fixed budgets); the custom guests in
Studio (bundled modules only); the import-root and source-prefix rows in Studio
(the adapter sets neither); and the 4,096- and 4,097-byte paths on the launcher
(the host filesystem cannot stage them).
