# Browser and Deno SDK

The SDK compiles schemas and generates C++, Rust, Go, and Zig from supplied Wasm
modules. It performs no filesystem or network operations. Build it with
`mise run build:sdk`: `dist/typescript/mod.js` is a standalone ES module with
TypeScript declarations, and `worker.js` is its bundled worker entrypoint.
`dist/wasm/` contains the same command binaries used by the native host tests;
`dist/include/` contains pinned standard schemas and language annotations.

The caller loads only the generators it needs, using its own asset URLs,
embedded bytes, or cache. Supply original `Uint8Array` module bytes. The SDK
compiles and retains bounded modules internally; opaque `WebAssembly.Module`
objects are rejected because their memory limits cannot be inspected or reduced
through the standard JavaScript API. No runtime imports point into `ref/` or to
a CDN.

```ts
import { createWorkerCompiler } from "./dist/typescript/mod.js";

const bytes = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return new Uint8Array(await response.arrayBuffer());
};
const compiler = await createWorkerCompiler("./dist/typescript/worker.js", {
  compiler: await bytes("./dist/wasm/capnp.wasm"),
  generators: { rust: await bytes("./dist/wasm/capnpc-rust.wasm") },
});
try {
  const result = await compiler.compile({
    files: {
      "person.capnp": "@0xece4bf9c1f867623; struct Person { name @0 :Text; }",
    },
    entrypoints: ["person.capnp"],
    generators: ["rust"],
  });
  console.log(new TextDecoder().decode(result.outputs.rust["person_capnp.rs"]));
} finally {
  compiler.dispose();
}
```

See [Schema Studio](../../examples/browser/README.md) for a complete browser
workbench with multi-file editing, language selection, and ZIP downloads, and
`examples/deno.ts` for a Deno example. Run `mise run example:browser` and open
its HTTP URL; opening the HTML file directly shows launch instructions. The
server only delivers static files; schema compilation runs in the browser.

## Reusing a compiled request

Both direct and worker compilers expose `generate` for already-compiled
requests. Compile with an empty generator list, then generate different target
sets without rerunning the frontend:

```ts
const compilation = await compiler.compile({
  files: workspaceFiles,
  includeFiles: standardSchemas,
  entrypoints: ["person.capnp"],
  generators: [],
});
const rust = await compiler.generate({
  request: compilation.request,
  generators: ["rust"],
});
```

`generate` returns `outputs` and `diagnostics`. It requires at least one
available generator and nonempty unpacked request bytes, up to `requestBytes`
(64 MiB by default). Request bytes are copied before execution; generators
validate their contents and report malformed requests through `CompileError`.
All requested generators must succeed before outputs are returned. Worker
`generate` accepts the same signal and timeout options as `compile`, and shares
its one-active-job limit. Cache requests only alongside the toolchain revision
and the full schema/include workspace they represent.

## Workspace and results

`compile` accepts `files`, optional `includeFiles`, `entrypoints`, and a list of
generator names (`cpp`, `rust`, `go`, `zig`). An empty generator list returns
just the compiler request. Paths are case-sensitive, relative POSIX paths: no
empty, `.` or `..` segments, backslashes, NUL, or malformed Unicode. A file
cannot also be a directory prefix. Entrypoints must be present in `files`;
duplicate entrypoints and generators fail before execution.

The compiler sees a read-only `/src` and `/include`. Relative schema imports
resolve normally within this snapshot. Absolute imports resolve through
`/include`; for example, supply `"capnp/c++.capnp"` for
`import "/capnp/c++.capnp"`. Go schemas need `"go.capnp"` and their upstream
`$Go.package`/`$Go.import` annotations. Dependencies must be present before the
job starts.

`importPaths` optionally supplies ordered directories within `files`, searched
before `/include` for absolute imports. `sourcePrefix` optionally chooses a
directory within `files` to strip from requested filenames. Both use canonical
relative POSIX directory names; `""` means the `/src` root. Absolute paths,
backslashes, parent traversal and duplicate import roots are rejected. These
options change compiler arguments only: schema text, read-only input isolation,
and the binary request format remain unchanged. For example:

```ts
const result = await compiler.compile({
  files: workspaceFiles,
  entrypoints: ["project/schema/person.capnp"],
  sourcePrefix: "project",
  importPaths: ["project/vendor", "shared"],
  generators: [],
});
// Requested filename: schema/person.capnp. Imports search project/vendor,
// then shared, then the separately supplied includeFiles snapshot.
```

This lets a filesystem adapter stage a finite dependency graph containing parent
imports and binary embeds, without copying entire include directories or
rewriting schema contents. The caller supplies all referenced files; the SDK
does not discover host paths.

For Zig, supply `generators: { zig: moduleBytes }` with `capnpc-zig.wasm` and
request `generators: ["zig"]`. Output uses `.zig` filenames and imports the
`capnpc-zig` runtime module. Bind that name to the pinned library, as shown in
[the Zig generator guide](../../generators/zig/README.md).

Each generator receives a fresh writable in-memory root and the compiler's
unpacked `CodeGeneratorRequest` on stdin. Results contain `request` bytes,
`outputs[language][relativePath]` bytes, and `diagnostics` with stage and raw
stderr. Inputs are copied before execution; returned bytes belong to the caller.
Nothing is written to the application's workspace. Results are returned only
when every requested generator succeeds.

Invalid SDK inputs reject with `TypeError`. Guest failures reject with
`CompileError`, whose `stage`, `diagnostics`, and optional `exitCode` preserve
the upstream failure. Traps also retain captured stderr. Source locations are
not inferred from human-readable diagnostics.

## Execution and cancellation

`createCompiler(modules, options?)` compiles modules once and runs jobs in the
current JS thread. Its interface is asynchronous, but each guest's execution
blocks that thread. This works in Deno and application-owned workers; it has no
hard timeout.

`createWorkerCompiler(workerURL, modules, options?)` executes off the main
thread. Its `compile(request, { signal, timeoutMs })` accepts an `AbortSignal`
and defaults to a 30-second deadline, including restart time. Aborting or timing
out requests worker termination and rejects the job. The next job creates a
fresh worker using private copies of the original modules. `dispose()` rejects
pending work and terminates the client permanently. One job may be active per
worker client; use separate clients for parallel jobs.

Deno worker execution currently requires **Deno 2.6.8**, exported as
`supportedDenoWorkerVersion`. Other Deno versions fail before a worker is
created, with guidance to use that version or `createCompiler` without a hard
deadline. Deno 2.6.8 deliberately allows a two-second engine termination grace
after `terminate()`; rejection does not mean guest CPU stopped immediately. The
client waits 2.1 seconds before restarting a terminated Deno worker, and
includes that wait in the next job's deadline. Browser workers do not use this
Deno delay. The [runtime evidence](../../docs/deno-worker-termination.md)
records a real shared counter that stops within the grace on 2.6.8 and continues
on newer tested engines. Direct compilation remains tested on the producer's
pinned Deno 2.9.6.

Worker initialization also has a 30-second timeout. Worker script loading is a
host action: to restart completely offline, fetch `worker.js` in advance and use
a blob URL, as the browser test does. Keep that URL alive until the client is
disposed. The SDK does not inject CSP exceptions; the application controls where
workers can be loaded.

## Resource limits

Both factory functions accept the same optional `{ limits }` argument. Omitted
fields use the exported `defaultLimits`. Limits are fixed for the lifetime of a
compiler and survive worker restart:

```ts
const compiler = await createWorkerCompiler(workerURL, modules, {
  limits: {
    workspaceBytes: 8 * 1024 * 1024,
    outputBytes: 16 * 1024 * 1024,
    memoryPages: 2048, // 128 MiB, in 64 KiB Wasm pages
  },
});
```

| Limit              | Default         | Scope                                                         |
| ------------------ | --------------- | ------------------------------------------------------------- |
| `memoryPages`      | 4,096 (256 MiB) | Linear memory of each guest instance                          |
| `workspaceBytes`   | 64 MiB          | Combined UTF-8/byte contents of `files` and `includeFiles`    |
| `workspaceEntries` | 4,096           | Combined files and implied directories, excluding mount roots |
| `pathBytes`        | 4,096           | UTF-8 bytes per workspace, entrypoint, or output path         |
| `requestBytes`     | 64 MiB          | Compiled or supplied unpacked request                         |
| `outputBytes`      | 64 MiB          | File contents retained by each generator                      |
| `outputEntries`    | 4,096           | Files and directories created by each generator               |
| `stdoutBytes`      | 64 MiB          | Captured stdout per command                                   |
| `stderrBytes`      | 1 MiB           | Captured stderr per command                                   |

Limits must be nonnegative safe integers. Zero disallows the corresponding
resource; `memoryPages` instead accepts 1 through 65,536. Compiler stdout is
also bounded by `requestBytes`. Workspace size is checked before encoding
strings, copying byte contents, or posting a worker message. String contents are
measured as UTF-8; returned and retained bytes remain private snapshots.

Before compilation, the SDK inserts or lowers the maximum in the module's memory
section. The engine then validates the resulting module and enforces its maximum
during initialization and every `memory.grow`, including growth that makes no
host calls. Initial memory above the configured ceiling is rejected. Only one
defined, unshared wasm32 memory is supported; imported, shared, memory64, and
multiple memories are rejected. This preserves a module's smaller existing
maximum. It does not change the guest's code or data sections.

Writable file limits are checked before writes, sparse writes, allocation, and
resizing. Renumbering a descriptor does not bypass its budget. Deleted files
remain accounted while their storage can be retained by descriptors, and entry
creation consumes a command-lifetime budget even if an entry is later removed.
Final output paths, entry counts, and bytes are validated before result copies,
including aliases. A guest that exceeds a host budget traps immediately and
rejects with `CompileError`; captured earlier stderr and the failure stage are
preserved, and no partial results are returned. Memory allocation failure is
reported through the guest's usual exit/trap behavior.

These are per-workspace/per-command bounds, not a total JavaScript heap or
process memory limit: snapshots, generated results, module compilation, and
concurrent clients need additional host storage. Use the worker API to bound
execution time as well as resources. The SDK is tested in the pinned Deno,
Chromium, Firefox, and WebKit versions; the C++ modules require standardized
Wasm exception handling.

Repeated active-worker cancellation stalled in the older tested WebKit revisions
2248 and 2311. The current WebKit 26.6 / revision 2359 passed the same stress
case. The
[browser evidence](../../tests/browser/README.md#engine-regression-evidence)
records this engine comparison; upgrading the test engine does not repair older
installed browsers. Validate the browser versions your application supports.

## Verification

`mise run test` runs the pinned-Deno SDK tests using only read permission,
including direct execution, explicit rejection of unsupported worker runtimes,
exact resource boundaries, oversized sparse output writes, descriptor
renumbering, and guest memory growth. CI additionally runs the same suite on
Deno 2.6.8 with worker tests enabled and a bounded subprocess probe of actual
worker termination, plus the external compiler-host package consumer. Worker
tests are explicitly ignored on unsupported Deno versions; that does not replace
the required supported-runtime lane. `mise run browser:install` installs the
pinned browsers, then `mise run test:browser` compares every generated byte with
native output in all three engines, blocks network and revokes process
permissions after loading assets, and tests worker cancellation and reuse. See
`tests/browser/README.md` for test-host requirements.
