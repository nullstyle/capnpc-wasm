# SDK contract

The [TypeScript SDK](../sdk/typescript/README.md) and the
[Go SDK](../sdk/go/README.md) implement one contract: the same request fields,
the same resource limits and defaults, the same stage names, the same error
classes by cause, the same diagnostics, and the same guest command lines. A
schema workspace compiled through either SDK produces the same
`CodeGeneratorRequest` bytes and the same generated files as the native tools.

This document is the reference for both SDKs and for the cross-host conformance
tests. Where the SDKs differ, the difference is listed here; an unlisted
difference is a bug in one of them. Changes to the contract need a line in
[CHANGELOG.md](../CHANGELOG.md) and follow the
[version rules](api-stability.md#version-rules): a break needs a minor release
(a major one from `1.0.0` on) and a CHANGELOG bullet marked breaking, and after
a flavor's `0.1.0` a deprecation period first.

The limit defaults are machine-readable in
[`tests/fixtures/contract/limits.json`](../tests/fixtures/contract/limits.json).
The Go test `TestContractLimits` asserts `DefaultLimits()` against it, and
`sdk/typescript/conformance_test.ts` asserts `defaultLimits` against the same
file.

## Names

| Concept            | TypeScript                                 | Go                                       |
| ------------------ | ------------------------------------------ | ---------------------------------------- |
| Compiler factory   | `createCompiler`, `createWorkerCompiler`   | `New(ctx, Modules, ...Option)`           |
| Module set         | `Modules { compiler, generators }`         | `Modules { Compiler, Generators }`       |
| Generator name     | `Language` (`"cpp" \| "rust" \| ...`)      | `Language` (`LanguageCpp`, ...)          |
| Compile request    | `CompileRequest`                           | `Request`                                |
| Generation request | `GenerationRequest`                        | `GenerationRequest`                      |
| Results            | `CompileResult`, `GenerationResult`        | `Result`, `GenerationResult`             |
| Diagnostic         | `Diagnostic { stage, stderr }`             | `Diagnostic { Stage, Language, Stderr }` |
| Resource limits    | `ResourceLimits`, `defaultLimits`          | `Limits`, `DefaultLimits()`              |
| Guest failure      | `CompileError`                             | `*Error` with a guest `Stage`            |
| Invalid input      | `TypeError`                                | `*Error` matching `ErrInvalidRequest`    |
| Exceeded limit     | `TypeError` or `CompileError` (see Limits) | `*Error` matching `ErrLimitExceeded`     |
| Closed             | `Error("worker compiler is disposed")`     | `*Error` matching `ErrClosed`            |
| Cancelled          | `DOMException` or `signal.reason`          | `*Error` wrapping the `context` error    |

## Languages and commands

`Language` is one of `cpp`, `rust`, `go`, and `zig`. The set may grow in a later
release: handle unknown values as data (a map lookup, a default branch) rather
than exhausting them in a switch or a `Record<Language, ...>`. Both SDKs reject
a generator that was not supplied to the factory before any guest runs.

Every guest is a WASI preview 1 command that exports `memory` and `_start`. The
SDKs run the compiler as

```text
capnp compile --no-standard-import [-I/src/<root>]... -I/include --src-prefix=/src [--src-prefix=/src/<prefix>] -o- /src/<entrypoint>...
```

where each import root is emitted in the caller's order (`-I/src` for the root
`""`), before `-I/include`, and the caller's source prefix follows the
unconditional `--src-prefix=/src`. The compiler sees read-only `/src` (the
caller's files) and `/include` (the caller's include files); its stdout is the
unpacked `CodeGeneratorRequest`.

Generators receive that request on stdin, an empty writable root, and exactly
one argument, their command name: `capnpc-c++`, `capnpc-rust`, `capnpc-go`, or
`capnpc-zig`. No generator options are passed; `--no-reflection`,
`--api-profile=compact`, and similar flags are reachable only through a command
host such as the launcher. A generator that writes to stdout fails the job.

The schema-inspection generator `capnpc-capnp` is built and shipped but is not a
`Language`: it writes its output to stdout, which the SDKs reject. Run it
through a command host or the test hosts.

## Request fields

| TypeScript     | Go             | Meaning                                                                                                                             |
| -------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `files`        | `Files`        | Application schemas and embeds, staged read-only beneath `/src`. TypeScript accepts strings (encoded as UTF-8) or bytes; Go, bytes. |
| `includeFiles` | `IncludeFiles` | Standard schemas and annotations, staged read-only beneath `/include`; absolute imports resolve here after the import roots.        |
| `importPaths`  | `ImportPaths`  | Ordered directories within `files`, searched for absolute imports before `/include`. `""` names `/src` itself.                      |
| `sourcePrefix` | `SourcePrefix` | A directory within `files` stripped from requested file names; `""` keeps names relative to `/src`.                                 |
| `entrypoints`  | `Entrypoints`  | Paths present in `files`; at least one.                                                                                             |
| `generators`   | `Generators`   | Languages to run in order; empty compiles only.                                                                                     |
| `request`      | `Request`      | (Generation) One unpacked `CodeGeneratorRequest`, nonempty and at most `requestBytes`.                                              |

Paths are canonical relative POSIX paths: valid UTF-8 (well-formed in
TypeScript), no backslashes or NUL bytes, and no empty, `.`, or `..` components.
A file cannot also be a directory prefix of another path in the same mount. An
import root or source prefix must be a directory implied by a path in `files`;
directories implied only by `includeFiles`, and files, do not qualify.

Validation runs completely before any guest starts, in this order, and both SDKs
report the first failure with the same message:

1. Generators: `too many generators` (more than four), `duplicate generators`,
   `generator was not supplied: <name>`.
2. Import roots: `import root count exceeds workspaceEntries limit`; then the
   source prefix and each root that is not `""`: `path exceeds pathBytes limit`
   or `expected a canonical relative POSIX path: <path>`; then
   `duplicate importPaths`.
3. Entrypoints: `at least one entrypoint is required`,
   `entrypoint count exceeds workspaceEntries limit`, each path as above, then
   `duplicate entrypoints`.
4. `files` then `includeFiles`, each path as above, counting files and implied
   directories into `workspace exceeds workspaceEntries limit` and contents into
   `workspace exceeds workspaceBytes limit`; then
   `file/directory collision: <path>`.
5. `entrypoint is not in files: <path>`,
   `importPath is not a directory in files: <path>`,
   `sourcePrefix is not a directory in files: <path>`.

For generation: generators as above, `at least one generator is required`,
`request must contain unpacked CodeGeneratorRequest bytes`, then
`request exceeds requestBytes limit`.

TypeScript additionally reports shape mistakes that Go's types prevent:
`expected a string path`, `expected text or bytes for <path>`,
`files must be an object mapping paths to contents`,
`includeFiles must be an object mapping paths to contents`,
`entrypoints must be an array of paths`,
`generators must be an array of language names`,
`importPaths must be an array of directory paths`,
`limits must be an object of resource limits`,
`compile request must be an object`, and `generation request must be an object`.

## Limits

Each limit is a nonnegative integer; zero disallows the resource, except
`memoryPages`, which is between 1 and 65,536. Omitted TypeScript limits (and
`undefined` entries) use the defaults; Go callers start from `DefaultLimits()`
and set fields. Invalid limits are rejected by the factory:
`invalid resource limit: <name>` or `memoryPages must be between 1 and 65536`.
Limits are fixed for the lifetime of a compiler.

| Limit              | Default         | Bounds                                                                                                                           | Detected                                                               |
| ------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `memoryPages`      | 4,096 (256 MiB) | Linear memory of each guest instance, in 64 KiB pages                                                                            | Factory (initial memory over the ceiling); guest growth fails in place |
| `workspaceBytes`   | 64 MiB          | Combined contents of `files` and `includeFiles`                                                                                  | Before the guest starts                                                |
| `workspaceEntries` | 4,096           | Files plus implied directories of `files` and `includeFiles`, excluding mount roots; the entrypoint count; the import root count | Before the guest starts                                                |
| `pathBytes`        | 4,096           | UTF-8 bytes of each workspace, entrypoint, import root, source prefix, and generated output path                                 | Before the guest starts; output paths while the generator runs         |
| `requestBytes`     | 64 MiB          | A request supplied to generation; the compiler's stdout                                                                          | Before the guest starts; the compiler's output while it runs           |
| `outputBytes`      | 64 MiB          | File contents each generator retains; removed and replaced files stay charged                                                    | While the generator runs                                               |
| `outputEntries`    | 4,096           | Files and directories each generator creates over its lifetime; removing an entry does not refund it                             | While the generator runs                                               |
| `stdoutBytes`      | 64 MiB          | Captured stdout per command; the compiler's stdout is bounded by the smaller of this and `requestBytes`                          | While the command runs                                                 |
| `stderrBytes`      | 1 MiB           | Captured stderr per command                                                                                                      | While the command runs                                                 |

A budget detected before any guest starts is invalid caller input; a budget a
running guest exceeds is a guest failure. One budget can surface both ways:
`requestBytes` rejects an oversized supplied request before generation and
bounds the compiler's output while it runs; `pathBytes` bounds caller paths
before the compiler starts and generated paths while a generator runs.

Guest memory exhaustion is not a limit error: `memory.grow` past `memoryPages`
fails inside the guest, which then exits or traps as it would on any host.

The SDKs stop a guest differently when it exceeds a run-time budget. TypeScript
records the budget in the WASI import, and the guest traps at the check right
after that call, so no guest code or exception handler runs after it; `cause`
names the limit. Go's wazero filesystem interface defines no `ENOSPC` or `EFBIG`
(unknown errno values reach the guest as `EIO`), so the guest observes `ERANGE`
for a byte or entry budget and `ENAMETOOLONG` for a path over `pathBytes`, may
continue, and is classified by the host when it stops: the job fails with the
budget whatever the guest's exit status, and its stderr, which may describe the
failed write, is preserved. Neither SDK publishes any output of a job that
exceeded a budget. TypeScript bounds every guest path argument at `pathBytes`

- 8 while the guest runs and checks generated paths exactly against `pathBytes`
  after a zero exit (`collectFiles`, which also re-counts entries and bytes
  across hard-link aliases), so an output path in between is reported only when
  the guest exited 0; Go rejects the creation and classifies the job whatever
  the exit status.

Fixed internal bounds are not limits: TypeScript caps live descriptors at 1,024
(`ENFILE`), and Go bounds filesystem lookups at `pathBytes` plus the longest
mount prefix (`/include/`), beyond which no path can name a staged node.

## Stages and diagnostics

A stage is `compiler` or a language name (`cpp`, `rust`, `go`, `zig`). Go adds
two stages that never run a guest: `validate` for rejected caller input and
options, and `modules` for modules `New` could not use. TypeScript reports both
as `TypeError` from the factory or the call.

A diagnostic is one stage's stderr, unmodified, without inferred source
locations. Results carry every stage's diagnostics in execution order, including
successful stages that wrote to stderr; stages that wrote nothing add no entry.
A guest failure carries the same list up to and including the failing stage, so
a warning from the compiler or an earlier generator is never lost when a later
generator fails. Go's `Diagnostic.Language` repeats the language for generator
stages and is empty for the compiler.

## Errors

| Cause                                                                                              | TypeScript                                                                                                                              | Go                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invalid caller input: paths, entrypoints, generators, import roots, request bytes, limits, options | `TypeError`, identical in direct and worker execution                                                                                   | `*Error{Stage: validate}` matching `ErrInvalidRequest`                                                                                                                                                                        |
| Caller input over a budget before any guest starts                                                 | `TypeError` reading `<subject> exceeds <limitName> limit`, including `initial guest memory exceeds memoryPages limit` from the factory  | `*Error{Stage: validate, Limit: "<limitName>"}` matching both `ErrInvalidRequest` and `ErrLimitExceeded`; a module whose initial memory exceeds `memoryPages` is `*Error{Stage: modules, Limit: "memoryPages"}` matching both |
| Module bytes empty, not a WASI command, or rejected by the engine                                  | `TypeError` from the factory; `the engine rejected the Wasm module: <engine>` with the engine error as `cause`                          | `*Error{Stage: modules}` matching `ErrInvalidRequest`; `Language` names the generator; `Err` wraps the engine error                                                                                                           |
| Engine without standardized Wasm exception handling                                                | `TypeError` from the factory before any module is compiled                                                                              | Not applicable: the pinned wazero supports it                                                                                                                                                                                 |
| A guest exits nonzero                                                                              | `CompileError{kind: "exit", stage, exitCode, diagnostics}`                                                                              | `*Error{Stage, Language, ExitCode, Diagnostics}`; `Err` reads `exited with status <n>`                                                                                                                                        |
| A guest traps                                                                                      | `CompileError{kind: "trap", stage, diagnostics, cause}` without `exitCode`                                                              | `*Error{Stage, Language, Diagnostics}` with `ExitCode` 0; `Err` wraps the runtime's trap error                                                                                                                                |
| A guest exceeds a budget while it runs                                                             | `CompileError{kind: "limit", limit, stage, diagnostics, cause}` without `exitCode`; the message names the limit too                     | `*Error{Stage, Language, Limit, Diagnostics}` matching `ErrLimitExceeded` only, `ExitCode` 0; `Err` reads `<limitName> resource limit exceeded`                                                                               |
| A guest exits 0 without honoring its contract                                                      | `CompileError{kind: "protocol"}` without `exitCode`: `compiler emitted no request`, `<language> generator unexpectedly wrote to stdout` | `*Error` with `ExitCode` 0: `compiler emitted an empty CodeGeneratorRequest`, `generator unexpectedly wrote to stdout`                                                                                                        |
| Cancelled                                                                                          | `DOMException` named `TimeoutError`, or the abort `signal.reason`, in both modes; the guest itself stops (see Parity)                   | `*Error` at the stage that was running (or `validate` before one ran) matching `context.Canceled` or `context.DeadlineExceeded`                                                                                               |
| Closed                                                                                             | `Error("worker compiler is disposed")`; direct compilers are not closed                                                                 | `*Error{Stage: validate}` matching `ErrClosed`; a job terminated by `Close` reports `ErrClosed` at its stage                                                                                                                  |
| Unsupported worker runtime                                                                         | `Error` naming the runtime and pointing to `createCompiler`                                                                             | Not applicable                                                                                                                                                                                                                |

`RangeError` is never used for limits; the worker protocol preserves a
`RangeError` only when the engine throws one.

TypeScript's `CompileError.kind` is `exit`, `trap`, `limit`, or `protocol`, and
`limit` names the exceeded budget exactly when the kind is `limit`. Go callers
derive the same kind from the fields: `Limit != ""` is a limit, `ExitCode != 0`
is an exit, one of the two contract messages above is a protocol failure, and
otherwise `Err` is the runtime's trap error.

The sentinels are disjoint: a guest failure never matches `ErrInvalidRequest`,
`ErrLimitExceeded`, or `ErrClosed`; cancellation and `ErrClosed` never match
`ErrInvalidRequest`.

## Results

Results are published only after every requested stage succeeds; on any failure
no partial file escapes. Outputs are keyed by language and then by the
generator's relative output path, with private copies of the bytes: inputs are
never aliased and later jobs never share buffers. `CompileResult.request` and
`Result.Request` hold the unpacked request the generators consumed, so a compile
with no generators followed by generation from that request produces the same
files as a single compile.

## Parity

| Capability          | TypeScript                                                                                                                                                                                                                                                              | Go                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Execution           | Direct (calling thread) or worker (off thread)                                                                                                                                                                                                                          | In process, on wazero's interpreter or compiler engine (`WithEngine`)                               |
| Cancellation        | Both modes: `signal` and `timeoutMs` (default 30 s), enforced by checks injected into every guest, which stop a guest that loops, recurses, or sleeps in `poll_oneoff`; a cancelled worker job keeps its worker. A direct job sees an abort before its next guest stage | `context.Context` deadline or cancellation stops the guest, including one sleeping in `poll_oneoff` |
| Concurrency         | One active job per worker client; direct jobs block the thread                                                                                                                                                                                                          | Concurrent jobs on one `Compiler`; `WithMaxConcurrentJobs` bounds them                              |
| Shutdown            | `dispose()` stops any running guest, rejects pending work, and terminates the worker                                                                                                                                                                                    | `Close(ctx)` rejects new calls, waits for active ones, and terminates them when `ctx` ends          |
| Module reuse        | Compiled once per factory; worker restarts recompile from private copies                                                                                                                                                                                                | Compiled once per `Compiler`; `WithCompilationCache` shares compiled code between compilers         |
| Limits              | `{ limits }` option on both factories                                                                                                                                                                                                                                   | `WithLimits(Limits)`                                                                                |
| Import roots        | `importPaths`, `sourcePrefix`                                                                                                                                                                                                                                           | `ImportPaths`, `SourcePrefix`                                                                       |
| Runtime requirement | Deno (tested on 2.9.6) or Bun (verified locally) in either mode, or a browser with standardized exception handling; Node.js direct execution only, best effort                                                                                                          | Go 1.25 or later with the pinned wazero pseudo-version                                              |

## Conformance

- Both SDKs are compared byte for byte with the native compiler and generators
  on the same workspaces, including the
  [feature corpus](../tests/fixtures/features/README.md) and the compiler-path
  fixture (`tests/package/compiler-path-fixture.ts`, mirrored in the Go test
  `TestCompilerPathFixtureMatchesNative`) with both import root orders.
- The limits fixture pins the defaults of both SDKs (`TestContractLimits` and
  `sdk/typescript/conformance_test.ts`).
- The
  [failure and limit conformance corpus](../tests/fixtures/conformance/README.md)
  runs one set of failing and budget-breaching inputs through TypeScript direct
  and worker execution, the Go SDK, the packaged launcher, each browser engine
  in both modes, and the Schema Studio adapter, and checks each outcome (`ok`,
  `validation`, `exit(n)`, `trap`, `trap:stack`, `limit:<budget>`,
  `policy:<rule>`, `protocol`, `timeout`) against one table in which every
  departure of a surface carries a reason and a finding. The runners derive the
  outcome from the fields this contract defines, as § Errors maps them.
- The invalid-schema fixtures under `tests/fixtures/invalid/` are compiler exit
  1 with clean diagnostics in both SDKs; malformed generation requests are
  generator exit 1 without outputs.
- Each budget is tested at its exact boundary in both SDKs: the value at the
  budget passes, one past it fails with the class and name above.
