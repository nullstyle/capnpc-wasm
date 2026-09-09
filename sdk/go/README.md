# Go host SDK

`capnpcwasm` compiles schema workspaces and runs C++, Rust, Go, and Zig
generators in wazero. The API accepts module bytes and schema bytes and returns
the standard unpacked `CodeGeneratorRequest`, generated file bytes, and stderr
diagnostics. Execution needs no native compiler, network access, or host
filesystem access.

```go
compiler, err := capnpcwasm.New(ctx, capnpcwasm.Modules{
	Compiler: compilerWasm,
	Generators: map[string][]byte{
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
	Generators: []string{"cpp", "rust", "go", "zig"},
})
if err != nil {
	return err
}
// result.Outputs["rust"]["person_capnp.rs"] contains generated source.
```

Import `github.com/nullstyle/capnpc-wasm/sdk/go` as `capnpcwasm`. Its public
wazero requirement is `v1.12.1-0.20260908083515-451613caac44`, the exact
pseudo-version for the repository's `ref/wazero` gitlink and standardized Wasm
exception support. Dependency checksums are committed in `go.sum`; applications
need no wazero replacement or sibling reference checkout.

Until a Go module version is published, use a local replacement for this SDK
module itself, or the self-contained source in a prepared release candidate. See
[release preparation and external installation checks](../../docs/releases.md).
A future nested module release uses a tag such as `sdk/go/v0.1.0-rc.1`.

Read modules from the candidate's `wasm/` directory, `build/wasm/bin/`, or embed
them in your application. The SDK does not download modules or supply annotation
schemas. Include the pinned standard schemas that your inputs import; C++
annotations are in `ref/capnproto/c++/src/capnp/c++.capnp` and Go annotations in
`ref/go-capnp/std/go.capnp`. Go generation requires the upstream `$Go.package`
and `$Go.import` annotations, as shown in the repository fixtures. An empty
`Generators` list runs only the compiler.

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
	Generators: []string{"rust", "go"},
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

## Execution and ownership

`New` validates that every module exports `memory` and a `_start` function with
no parameters or results, then retains the compiled modules. A compiler that
exits successfully with empty stdout still fails the job because it did not
produce a `CodeGeneratorRequest`. Reuse the returned compiler across concurrent
jobs; every command receives a fresh module instance and private memory
filesystem. The compiler sees read-only `/src` and `/include` directories. Each
generator sees an empty writable root. There are no host mounts, symbolic links,
sockets, inherited environment variables, or subprocesses.

Input paths and entrypoints must be nonempty, valid UTF-8, relative POSIX paths
with no `.` or `..` components, empty components, backslashes, or NUL bytes.
Duplicate entrypoints, duplicate generators, missing entrypoints, unavailable
generators, and file/directory collisions fail before guest execution. Paths are
limited to 4,096 bytes. Workspace contents are limited to 64 MiB and 4,096 files
and directories. An existing generation request must be nonempty and at most 64
MiB. Each generator filesystem is limited to 64 MiB of file contents and 4,096
entries. A command can emit at most 64 MiB on stdout and 1 MiB on stderr; each
Wasm instance has a 256 MiB linear-memory ceiling. These are per-job limits, not
a process-wide memory budget.

Do not mutate request maps, generator lists, or byte slices while `Compile` or
`Generate` runs. `Generate` takes a private copy of the supplied request.
Returned maps and bytes belong to the caller and do not alias inputs or later
jobs. The SDK returns a zero result on every error, including a later generator
failure after earlier generators succeeded. Inspect `*capnpcwasm.Error` for the
failing stage, generator language, raw stderr, and wrapped error. Successful
stderr is retained in `Result.Diagnostics` without parsing upstream diagnostic
syntax.

Pass a cancellable context or deadline to interrupt guest execution.
`errors.Is(err, context.Canceled)` and `context.DeadlineExceeded` work through
the SDK error wrapper. `Close` waits for active calls, then frees the runtime;
cancel their contexts first when shutdown must interrupt them. Closing twice is
safe. Module instantiation and filesystem operations use the pinned wazero
experimental interfaces; this is an initial API, not a stable published release.

## Verification

Run from the repository root:

```sh
mise run build
mise exec -- go -C sdk/go test -count=1 ./...
mise exec -- go -C sdk/go vet -stdmethods=false ./...
```

Tests run the actual built modules, compare canonical requests and generated
source with native upstream tools, run concurrent and repeated jobs, and cover
Unicode paths, compile-once request reuse, validation, read-only inputs,
filesystem bounds, diagnostic preservation, transactional generator failures,
and cancellation of a running infinite Wasm loop. Native tools are used only by
the test oracle.

Use `-count=1` because Wasm modules and shared fixtures live outside the Go
module; Go's test cache does not reliably track their changes.

The `stdmethods` vet analyzer is disabled for this package because wazero's
experimental filesystem requires `Seek(int64, int) (int64, sys.Errno)`, which
intentionally differs from the standard `io.Seeker` signature. Other vet
analyzers remain enabled.
