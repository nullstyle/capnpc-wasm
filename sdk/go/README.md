# Go host SDK

`capnpcwasm` compiles schema workspaces and runs C++, Rust, Go, and Zig
generators in wazero. The API accepts module bytes and schema bytes and returns
the standard unpacked `CodeGeneratorRequest`, generated file bytes, and stderr
diagnostics. Execution needs no native compiler, network access, or host
filesystem access. The request fields, limits, stage names, and error model are
shared with the TypeScript SDK and defined in the
[SDK contract](../../docs/sdk-contract.md).

```go
compiler, err := capnpcwasm.New(ctx, capnpcwasm.Modules{
	Compiler: compilerWasm,
	Generators: map[capnpcwasm.Language][]byte{
		"cpp": cppGeneratorWasm,
		"rust": rustGeneratorWasm,
		"go": goGeneratorWasm,
		"zig": zigGeneratorWasm,
	},
})
if err != nil {
	return err
}
defer compiler.Close(context.Background())

result, err := compiler.Compile(ctx, capnpcwasm.Request{
	Files: map[string][]byte{"person.capnp": schemaBytes},
	IncludeFiles: map[string][]byte{
		"capnp/c++.capnp": cppAnnotationBytes,
		"go.capnp": goAnnotationBytes,
	},
	Entrypoints: []string{"person.capnp"},
	Generators: []capnpcwasm.Language{"cpp", "rust", "go", "zig"},
})
if err != nil {
	return err
}
// result.Outputs["rust"]["person_capnp.rs"] contains generated source.
```

Import `github.com/nullstyle/capnpc-wasm/sdk/go` as `capnpcwasm`; the package
name differs from the import path's last element because `go` is a keyword. Its
public wazero requirement is `v1.12.1-0.20260908083515-451613caac44`, the exact
pseudo-version for the repository's `ref/wazero` gitlink and standardized Wasm
exception support. Dependency checksums are committed in `go.sum`; applications
need no wazero replacement or sibling reference checkout.

Until a Go module version is published, use a local replacement for this SDK
module itself, or the self-contained source in a prepared release candidate. See
[release preparation and external installation checks](../../docs/releases.md).
The nested module is tagged `sdk/go/v<version>` with the version in
`release.json`, for example `sdk/go/v0.1.0-rc.3`, so that
`go get github.com/nullstyle/capnpc-wasm/sdk/go@v0.1.0-rc.3` resolves it.

Read modules from the candidate's `wasm/` directory, `build/wasm/bin/`, or embed
them in your application. The SDK does not download modules or supply annotation
schemas. Include the pinned standard schemas that your inputs import; C++
annotations are in `ref/capnproto/c++/src/capnp/c++.capnp` and Go annotations in
`ref/go-capnp/std/go.capnp`. Go generation requires the upstream `$Go.package`
and `$Go.import` annotations, as shown in the repository fixtures. An empty
`Generators` list runs only the compiler. `Language` may gain members in later
releases; treat unknown values as data rather than exhausting them in a switch.

The `zig` generator emits source for the pinned `ref/capnp-zig` runtime. Its
module is `build/wasm/bin/capnpc-zig.wasm`; generated files retain schema paths
with the `.capnp` suffix replaced by `.zig`.

Keep that request to generate additional languages without compiling the
workspace again:

```go
compiled, err := compiler.Compile(ctx, capnpcwasm.Request{
	Files: schemaFiles,
	IncludeFiles: standardSchemas,
	Entrypoints: []string{"person.capnp"},
})
if err != nil {
	return err
}
generated, err := compiler.Generate(ctx, capnpcwasm.GenerationRequest{
	Request: compiled.Request,
	Generators: []capnpcwasm.Language{"rust", "go"},
})
if err != nil {
	return err
}
// generated.Outputs["rust"]["person_capnp.rs"] contains generated source.
```

`Generate` also accepts an unpacked `CodeGeneratorRequest` produced by the
native compiler or another SDK host. It requires at least one generator and
returns a `GenerationResult` containing `Outputs` and `Diagnostics`. The
generators parse the supplied request; the SDK does not interpret or rewrite it.
`New` still requires the compiler module even when the application only calls
`Generate`.

## Import roots and source prefixes

`ImportPaths` optionally lists directories within `Files`, searched in order
before `/include` for absolute imports. An empty list adds no roots; the element
`""` names the `/src` root itself. `SourcePrefix` optionally chooses a directory
within `Files` to strip from requested file names; `""` (the default) keeps
names relative to `/src`. Both use canonical relative POSIX directory names.
Absolute paths, backslashes, parent traversal, duplicate import roots, and
entries that are not directories implied by a path in `Files` (missing
directories, files, or directories implied only by `IncludeFiles`) are rejected
before the compiler runs. These options change compiler arguments only, in the
same order as the TypeScript SDK: `-I/src/<root>` for each root before
`-I/include`, then `--src-prefix=/src/<prefix>` after `--src-prefix=/src`.

```go
result, err := compiler.Compile(ctx, capnpcwasm.Request{
	Files:        workspaceFiles,
	Entrypoints:  []string{"project/schema/person.capnp"},
	SourcePrefix: "project",
	ImportPaths:  []string{"project/vendor", "shared"},
})
// Requested filename: schema/person.capnp. Imports search project/vendor,
// then shared, then the separately supplied IncludeFiles snapshot.
```

## Engines and options

`New` accepts functional options. `WithEngine` selects the wazero engine:

- `EngineAuto`, the default, runs the compiler and the `cpp` generator on
  wazero's interpreter, and the `rust`, `go`, and `zig` generators on wazero's
  compiler where the platform supports it (amd64 with SSE4.1 or arm64 on the
  major operating systems, with executable memory available).
- `EngineCompiler` requests the compiler for every module. Where wazero does not
  support it, wazero runs its interpreter instead; `New` never panics.
- `EngineInterpreter` runs every module on the interpreter.

The pinned wazero compiler copies the Go stack on every Wasm `try_table` entry,
and the C++ modules enter thousands per job. On the compiler engine the `cpp`
generator takes 2.6 s and allocates 155 GB for `rpc.capnp` plus `schema.capnp`;
on the interpreter it takes 0.36 s and allocates 83 MB. The other generators
contain no `try_table` and run 9-20x faster on the compiler. The interpreter
also compiles modules about 10x faster, so `EngineInterpreter` suits one-shot
processes that run few jobs. `bench_test.go` measures every engine.

`WithCompilationCache` shares compiled code between compilers through a
`wazero.CompilationCache`, in memory or in a directory. The cache outlives the
compilers that use it; close it after the last one. Modules compile concurrently
in `New`.

`WithMaxConcurrentJobs(n)` bounds the `Compile` and `Generate` calls that run
guests at once. Further calls wait for a slot until their context ends or
`Close` terminates them; a job that never ran fails at stage `validate` with its
context error or `ErrClosed`. Without the option, jobs are unbounded.

## Resource limits

`WithLimits` replaces the defaults for every job of the compiler. Start from
`DefaultLimits()` and change the fields to bound; every field must be
nonnegative and `MemoryPages` between 1 and 65,536. Zero disallows the
corresponding resource. The names and defaults match the TypeScript SDK's
`ResourceLimits` and are pinned by
[`tests/fixtures/contract/limits.json`](../../tests/fixtures/contract/limits.json).

```go
limits := capnpcwasm.DefaultLimits()
limits.WorkspaceBytes = 8 << 20
limits.OutputBytes = 16 << 20
limits.MemoryPages = 2048 // 128 MiB, in 64 KiB Wasm pages
compiler, err := capnpcwasm.New(ctx, modules, capnpcwasm.WithLimits(limits))
```

| Field              | Default         | Scope                                                                                     |
| ------------------ | --------------- | ----------------------------------------------------------------------------------------- |
| `MemoryPages`      | 4,096 (256 MiB) | Linear memory of each guest instance                                                      |
| `WorkspaceBytes`   | 64 MiB          | Combined contents of `Files` and `IncludeFiles`                                           |
| `WorkspaceEntries` | 4,096           | Combined files and implied directories, excluding mount roots; entrypoint and root counts |
| `PathBytes`        | 4,096           | UTF-8 bytes per workspace, entrypoint, import root, source prefix, or output path         |
| `RequestBytes`     | 64 MiB          | Compiled or supplied unpacked request                                                     |
| `OutputBytes`      | 64 MiB          | File contents retained by each generator                                                  |
| `OutputEntries`    | 4,096           | Files and directories created by each generator over its lifetime                         |
| `StdoutBytes`      | 64 MiB          | Captured stdout per command; the compiler's is also bounded by `RequestBytes`             |
| `StderrBytes`      | 1 MiB           | Captured stderr per command                                                               |

Caller input over a budget is rejected before any guest starts: the returned
`*Error` has stage `validate`, names the budget in `Limit`, and matches both
`ErrInvalidRequest` and `ErrLimitExceeded`. A budget a running guest exceeds
(stdout, stderr, output bytes or entries, output path length, or the compiler's
request output over `RequestBytes`) fails the job at the guest's stage with an
`*Error` that names the budget in `Limit` and matches `ErrLimitExceeded` only,
whatever exit status the guest chose. The guest observes `ERANGE` for a byte or
entry budget and `ENAMETOOLONG` for an output path over `PathBytes`, because
wazero's filesystem interface defines no `ENOSPC` or `EFBIG`; its stderr is
preserved. Output bytes stay charged after a file is removed, truncated, or
renamed, and entry creation consumes a command-lifetime budget. Growth past
`MemoryPages` fails inside the guest, which then exits or traps as it would on
any host. These are per-job limits, not a process-wide memory budget.

## Execution and ownership

`New` validates that every module exports `memory` and a `_start` function with
no parameters or results, then retains the compiled modules. A compiler that
exits successfully with empty stdout still fails the job because it did not
produce a `CodeGeneratorRequest`. Reuse the returned compiler across concurrent
jobs; every command receives a fresh module instance and private memory
filesystem. The compiler sees read-only `/src` and `/include` directories. Each
generator sees an empty writable root and runs under its native command name
(`capnpc-c++`, `capnpc-rust`, `capnpc-go`, `capnpc-zig`) with no other
arguments. There are no host mounts, symbolic links, sockets, inherited
environment variables, or subprocesses.

Input paths and entrypoints must be nonempty, valid UTF-8, relative POSIX paths
with no `.` or `..` components, empty components, backslashes, or NUL bytes.
Duplicate entrypoints, duplicate generators, missing entrypoints, unavailable
generators, and file/directory collisions fail before guest execution, with the
same messages as the TypeScript SDK. Every path within `PathBytes` reaches the
compiler, including paths of 4,092 to 4,096 bytes.

Do not mutate request maps, generator lists, or byte slices while `Compile` or
`Generate` runs. `Generate` takes a private copy of the supplied request.
Returned maps and bytes belong to the caller and do not alias inputs or later
jobs. The SDK returns a zero result on every error, including a later generator
failure after earlier generators succeeded. Successful stderr is retained in
`Result.Diagnostics` in execution order without parsing upstream diagnostic
syntax; a diagnostic's `Stage` is `compiler` or the generator's language.

## Errors

Every call returns a `*capnpcwasm.Error`. Test its cause with `errors.Is` and
read its fields with `errors.As`:

| Field         | Meaning                                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Stage`       | `validate` (rejected input or options), `modules` (a module `New` could not use), `compiler`, or the generator's language                                        |
| `Language`    | The generator for a generator stage, or the generator whose module `New` rejected                                                                                |
| `ExitCode`    | The failing guest's nonzero exit status; 0 for a trap, an exceeded limit, cancellation, rejected input, or a command that exited 0 without honoring its contract |
| `Limit`       | The exceeded budget's name (`workspaceBytes`, `outputEntries`, ...) or empty                                                                                     |
| `Diagnostics` | Every stage's stderr so far in execution order, including the failing stage's                                                                                    |
| `Stderr`      | The failing stage's stderr                                                                                                                                       |
| `Err`         | The underlying error: the contract message, `exited with status N`, the runtime's trap error, or the context error                                               |

| Failure                                                                                       | `errors.Is`                                      |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Invalid paths, entrypoints, generators, import roots, request bytes, options, or module bytes | `ErrInvalidRequest`                              |
| Caller input over a budget                                                                    | `ErrInvalidRequest` and `ErrLimitExceeded`       |
| A guest exceeded a budget while it ran                                                        | `ErrLimitExceeded` only                          |
| Cancelled or past its deadline                                                                | `context.Canceled` or `context.DeadlineExceeded` |
| Called on a closed compiler, or terminated by `Close`                                         | `ErrClosed`                                      |
| A guest exited nonzero, trapped, or broke its contract                                        | None; inspect `ExitCode`, `Stderr`, and `Err`    |

Invalid schemas are a compiler exit 1 with the compiler's diagnostics; malformed
generation requests are a generator exit 1 with the generator's diagnostics.

Pass a cancellable context or deadline to interrupt guest execution, including a
guest sleeping in `poll_oneoff`; the guest stops at its next loop or function
entry. `New` checks its context before each module compilation starts and after
all of them finish, but one module's compilation cannot be interrupted.

`Close` marks the compiler closed, so new calls fail with `ErrClosed` at once,
and waits for active calls. If its context ends first, `Close` terminates the
active calls, which fail with `ErrClosed`, and returns the context error; the
runtime is released as soon as the last of them stops. Cancel job contexts first
when they should fail with their own errors instead. Closing twice is safe.
Module instantiation and filesystem operations use the pinned wazero
experimental interfaces; this is an initial API, not a stable published release.

## Verification

Run from the repository root:

```sh
mise run build
mise run --skip-deps test:sdk-go
mise run --skip-deps test:sdk-go-race
mise exec -- go -C sdk/go vet -stdmethods=false ./...
mise exec -- go -C sdk/go test -run '^$' -bench . -benchmem ./...
```

The tests share one compiler built from the real modules. Set
`CAPNPC_WASM_TEST_ENGINE=compiler` or `interpreter` to run the suite under one
engine; the default is `auto`. `-short` skips `TestSchemaFeatures`, which
compares every feature scenario with native output. A failed native comparison
keeps its work directory under `build/test/`; set `CAPNP_KEEP_TEST_DIRS=1` to
keep them after success too.

Inside the repository checkout, tests that need the built modules, the native
oracle, or the shared fixtures fail with build instructions when those are
missing. Outside the checkout, such as `go test` of a downloaded module, they
skip, and the self-contained tests (filesystem, limits, errors, and options
against embedded guests) still run. `CAPNPC_WASM_TEST_MODULES` points the tests
at another directory of command modules.

Tests run the actual built modules, compare canonical requests and generated
source with native upstream tools (including the compiler-path fixture with both
import root orders), run concurrent and repeated jobs, and cover Unicode paths,
compile-once request reuse, validation messages, read-only inputs, every limit
at its exact boundary before and during guest execution, the memory filesystem's
errno table, diagnostic preservation across failed stages, exit codes, sentinel
errors, transactional generator failures, cancellation of looping and sleeping
guests, bounded concurrency, Close against active and waiting calls, and every
engine option. `FuzzValidPath` and `FuzzGuestPath` compare the path rules with
the standard library. Native tools are used only by the test oracle.

Use `-count=1` because Wasm modules and shared fixtures live outside the Go
module; Go's test cache does not reliably track their changes.

The `stdmethods` vet analyzer is disabled for this package because wazero's
experimental filesystem requires `Seek(int64, int) (int64, sys.Errno)`, which
intentionally differs from the standard `io.Seeker` signature. Other vet
analyzers remain enabled.
