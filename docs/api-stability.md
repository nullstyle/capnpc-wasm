# API stability and versioning

This policy states which interfaces a version covers, how a version changes when
they change, how a deprecation is announced, and how packages, archives, and
tags are named. It applies to every archive flavor and to the Go module.
[Releases](releases.md) describes how a version is built and published, and
[CHANGELOG.md](../CHANGELOG.md) records the changes of each flavor.

## Names and versions

One naming rule covers every published artifact:

- `capnp-wasm-<part>` names an artifact that ships the compiler without the
  SDKs: `capnp-wasm-tools` (the compiler and the Wasmtime launcher) and
  `capnp-wasm-compiler-host` (the compiler and the TypeScript host). A new
  compiler-only artifact takes a new `<part>`.
- `capnpc-wasm` names the full SDK: the package `@nullstyle/capnpc-wasm`, its
  archive, and the Go module's tag. The Go module ships in the full SDK archive
  and takes its version.

| Flavor                     | Package                               | Archive                                  | Release tag                           | Go module tag       |
| -------------------------- | ------------------------------------- | ---------------------------------------- | ------------------------------------- | ------------------- |
| `capnpc-wasm`              | `@nullstyle/capnpc-wasm`              | `capnpc-wasm-<version>.tgz`              | `capnpc-wasm-v<version>`              | `sdk/go/v<version>` |
| `capnp-wasm-tools`         | `@nullstyle/capnp-wasm-tools`         | `capnp-wasm-tools-<version>.tgz`         | `capnp-wasm-tools-v<version>`         | None                |
| `capnp-wasm-compiler-host` | `@nullstyle/capnp-wasm-compiler-host` | `capnp-wasm-compiler-host-<version>.tgz` | `capnp-wasm-compiler-host-v<version>` | None                |

The repository is `nullstyle/capnpc-wasm`, and the Go module path is
`github.com/nullstyle/capnpc-wasm/sdk/go` (package `capnpcwasm`). Registry
packages (npm, JSR) come later and keep these names.

Each flavor has its own version, `versions["<flavor>"]` in `release.json`, and
its own release cadence: releasing one flavor never changes the version of
another. A version names one set of bytes. It is never reused, and
`scripts/release.ts` refuses a flavor version whose tag exists at another
commit. The Go module tag `sdk/go/v<version>` takes the `capnpc-wasm` version
and points at the same commit as `capnpc-wasm-v<version>`.

The full SDK and the compiler host ship the same TypeScript SDK. The rules below
apply to each flavor's version separately: when the TypeScript API changes, each
of the two takes the matching version change at its next release.

## Stable tier

A stable interface changes only as the [version rules](#version-rules) allow.
The TypeScript exports are those of a package's main entry (`typescript/mod.js`
with `typescript/mod.d.ts`, built from `sdk/typescript/mod.ts`); the Go exports
are those of package `capnpcwasm`. The lists below name every export on `main`;
a change that adds, removes, or deprecates an export updates them in the same
commit.

TypeScript:

- Factories: `createCompiler` and `createWorkerCompiler`, and the `Compiler`
  (`compile`, `generate`) and `WorkerCompiler` (`compile`, `generate`,
  `dispose`, `[Symbol.dispose]`) objects they return.
- Requests and options: `CompileRequest`, `GenerationRequest`, `Modules`,
  `WasmModule`, `Files`, `Language`, `CompilerOptions`, `WorkerCompilerOptions`,
  `JobOptions`, and `ResourceLimits`.
- Results and errors: `CompileResult`, `GenerationResult`, `Diagnostic`, and
  `CompileError` (`instanceof`, `name`, `stage`, `diagnostics`, `exitCode`, and
  `cause`).
- Constants and probes: `defaultLimits`, `supportedDenoWorkerVersion`,
  `supportsWasmExceptions()`, and `isBoundedWorkerSupported()`.
- Package entry points: `.`, `./worker`, `./wasm/*`, `./include/*`, and
  `./manifest.json`. Load `./worker` from the same package version as `.`.

Go:

- `New`, and the `Compiler` methods `Compile`, `Generate`, and `Close`.
- `Modules`, `Request`, `Result`, `GenerationRequest`, `GenerationResult`, and
  `Diagnostic`.
- `Error` (its fields, `Error`, and `Unwrap`) and the sentinels
  `ErrInvalidRequest`, `ErrLimitExceeded`, and `ErrClosed`.
- `Language` with `LanguageCpp`, `LanguageRust`, `LanguageGo`, and
  `LanguageZig`; `Stage` with `StageValidate`, `StageModules`, and
  `StageCompiler`.
- `Limits` and `DefaultLimits`; `Option` with `WithLimits`,
  `WithMaxConcurrentJobs`, `WithEngine` (`Engine`: `EngineAuto`,
  `EngineCompiler`, `EngineInterpreter`), and `WithCompilationCache`. Which
  engine `EngineAuto` selects for a module is not specified, and the cache is
  wazero's own type at the pinned wazero version.

Both SDKs: the behavior that the [SDK contract](sdk-contract.md) specifies:
request fields, path rules, the validation order and the messages it lists,
limit names and defaults, stage names, error classes, and guest command lines.
Raising a default limit is compatible; lowering one is a break.

Archives: the package layout (`wasm/`, `include/`, `typescript/`, `sdk/go/`,
`bin/capnp-wasm`, `runtime/wasmtime-version`, `manifest.json` in format 1, and
`verify-release.ts` with its options), and the launcher's modes, options, and
exit statuses in the
[launcher contract](releases.md#repository-toolchain-launcher).

These changes are compatible, and a patch release may make them: a new optional
field in a request or options type, a new field in a result or error, a new
export, option, stage, or `Language` value, and a new package entry point. Code
that implements the SDK interfaces itself, exhausts `Language` or `Stage` in a
switch (the SDK contract asks callers to treat unknown values as data), or
builds Go structs from unkeyed literals can break on such a change. `mod.d.ts`
declares `supportedDenoWorkerVersion` and some fields of `defaultLimits` with
literal types (`"2.6.8"`, `memoryPages: 4096`); type your own values as `string`
and `ResourceLimits`, because a compatible release may change them.

## Experimental tier

An experimental interface may change or disappear in any release, including a
patch release, with a CHANGELOG bullet and without a deprecation period.

- The launcher's environment overrides: `CAPNP_WASM_WASMTIME`,
  `CAPNP_WASM_WASMTIME_ACCEPT_VERSION`, `CAPNP_WASM_MAX_MEMORY`,
  `CAPNP_WASM_TIMEOUT`, and `CAPNP_WASM_MAX_WORKSPACE`.
- Timing: worker start-up and restart, the engine's termination grace, and how
  long a cancelled job takes to settle.
- Generation from a saved `CodeGeneratorRequest` that a different version
  compiled. `generate` and `Generate` are stable for requests from the same
  version; key a cache of requests by package version and workspace.
- The `globals` argument of `isBoundedWorkerSupported`, and constructing a
  `CompileError` in application code.
- Schema Studio (`examples/browser/`): its interface, saved state, and workspace
  ZIP layout.

## Not covered

- Diagnostic text. It is the guest's stderr, unchanged, and follows the pinned
  upstream sources. Match on stages, exit codes, limits, and error classes, and
  on a message only when the SDK contract lists it.
- The bytes of the Wasm modules, compiled requests, generated source, and
  archives. A change to the runtime revision that a generator's output needs
  (the [runtime requirements](../README.md#generated-code-runtime-requirements))
  is a break for the flavors that ship that generator.
- Modules under `sdk/typescript/` that `mod.ts` does not export, the message
  protocol between a package's main entry and `./worker`, and the Go SDK's
  unexported identifiers.
- The test hosts under `tests/hosts/`, the repository's scripts and `mise`
  tasks, and the files under an archive's `provenance/`.

## Version rules

Versions follow [Semantic Versioning 2.0.0](https://semver.org/). While the
major version is 0:

- A minor release (`0.1.x` to `0.2.0`) may break a stable interface. Each break
  has its own CHANGELOG bullet marked breaking (`<area>, breaking: ...`) that
  says what changed and what to use instead.
- A patch release (`0.1.0` to `0.1.1`) never breaks a stable interface. It
  carries fixes and compatible additions.
- `X.Y.Z-rc.N` is the Nth candidate of `X.Y.Z`, and all candidates of one
  version count as that version. They are measured against the previous final
  release, and a later candidate may still change what an earlier candidate of
  the same version added, with a CHANGELOG bullet (marked breaking if it
  breaks). The interface of a version is fixed when `X.Y.Z` itself is released,
  so a flavor's interface is not fixed before its `0.1.0`.
- An experimental interface may change in any release.

From `1.0.0` on, a break needs a major release.

## Deprecation

A stable interface is deprecated before it is removed or changed incompatibly:

1. The release that deprecates it says so in a CHANGELOG bullet and in its
   documentation comment (`@deprecated` in TypeScript, a `Deprecated:` paragraph
   in Go), naming the replacement.
2. It keeps working for the rest of that minor series.
3. It is removed no earlier than the next minor release: an interface deprecated
   in `0.2.x` can go in `0.3.0`, with a CHANGELOG bullet marked breaking.

An interface that only candidates of the upcoming version have shipped needs no
deprecation period; a later candidate may change it, as the version rules say.
