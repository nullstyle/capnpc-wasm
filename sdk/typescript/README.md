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

const bytes = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return new Uint8Array(await response.arrayBuffer());
};
const compiler = await createWorkerCompiler(
  new URL("./dist/typescript/worker.js", location.href),
  {
    compiler: await bytes("./dist/wasm/capnp.wasm"),
    generators: { rust: await bytes("./dist/wasm/capnpc-rust.wasm") },
  },
);
try {
  const result = await compiler.compile({
    files: {
      "person.capnp": "@0xece4bf9c1f867623; struct Person { name @0 :Text; }",
    },
    entrypoints: ["person.capnp"],
    generators: ["rust"],
  });
  // `outputs` is keyed by the generators you requested, so index it with `!`
  // (or a guard) under strict TypeScript.
  console.log(
    new TextDecoder().decode(result.outputs.rust!["person_capnp.rs"]),
  );
} finally {
  compiler.dispose();
}
```

The worker URL is resolved once, when the client is created: a relative string
resolves against `location.href` in browsers, and Deno needs an absolute URL (or
a `URL` object). Engines that expose `Symbol.dispose` can also manage the client
with `using`.

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

`importPaths` optionally lists directories within `files`, searched in order
before `/include` for absolute imports. An omitted or empty list adds no roots;
the element `""` names the `/src` root itself. `sourcePrefix` optionally chooses
a directory within `files` to strip from requested filenames; `""` (the default)
keeps names relative to `/src`. Both use canonical relative POSIX directory
names. Absolute paths, backslashes, parent traversal, duplicate import roots,
and entries that are not directories implied by a path in `files` (missing
directories, or files) are rejected with `TypeError` before the compiler runs.
These options change compiler arguments only: schema text, read-only input
isolation, and the binary request format remain unchanged. For example:

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
when every requested generator succeeds. `outputs` and each language's file map
are plain objects in both execution modes. Output names are chosen by the
generator and defined as own properties, so a file called `__proto__` is an
ordinary entry; enumerate with `Object.keys` or `Object.entries`.

## Errors

Both factories and both execution modes throw the same classes with the same
messages; the worker path rebuilds them from a typed protocol rather than
matching on `name`, and `cause` carries a name/message summary of the original
cause chain.

| Failure                                                                                                                                                   | Rejection                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Invalid caller input: paths, entrypoints, generators, import roots, request bytes, limits, module shape                                                   | `TypeError`, before any copy, post, or guest start                                                                                      |
| Module bytes the SDK cannot bound, or that the engine rejects (corrupt bytes, unsupported instructions)                                                   | `TypeError`; when the engine rejected it, `cause` is the engine's `WebAssembly.CompileError`                                            |
| Engine without standardized Wasm exception handling                                                                                                       | `TypeError` from the factory, before any module is compiled; see below                                                                  |
| A guest stage exits nonzero                                                                                                                               | `CompileError` with `stage`, `exitCode`, and every stage's `diagnostics`                                                                |
| A guest stage traps, or exceeds a host budget while running (stdout, stderr, output bytes or entries, path length, or `requestBytes` for compiler output) | `CompileError` with `stage`, no `exitCode`, `diagnostics` captured so far, and `cause`; a budget failure names the limit in its message |
| A caller input exceeds a budget before any guest starts (`workspaceBytes`, `workspaceEntries`, `pathBytes`, or `requestBytes` for a supplied request)     | `TypeError` reading `<subject> exceeds <limit> limit`                                                                                   |
| Worker job cancelled                                                                                                                                      | `DOMException` named `TimeoutError`, or the abort `signal.reason` (an `AbortError` by default)                                          |
| Worker client disposed, or a second concurrent job                                                                                                        | `Error` (`worker compiler is disposed`, `worker compiler already has an active job`)                                                    |
| Worker script failed to load, or the worker crashed                                                                                                       | `Error` with the engine's message                                                                                                       |
| Unsupported worker runtime                                                                                                                                | `Error` naming the runtime and pointing to `createCompiler`                                                                             |

One budget can therefore surface either way, depending on when it is detected:
`generate` rejects an oversized supplied request with `TypeError` before
starting, while `compile` bounds the compiler's request output with the same
`requestBytes` limit while the guest runs and reports an overrun as
`CompileError`. Traps also retain captured stderr. Source locations are not
inferred from human-readable diagnostics.

## Execution and cancellation

`createCompiler(modules, options?)` compiles modules once and runs jobs in the
current JS thread. Its interface is asynchronous, but each guest's execution
blocks that thread. This works in Deno and application-owned workers; it has no
hard timeout.

`createWorkerCompiler(workerURL, modules, options?)` executes off the main
thread. Its `compile(request, { signal, timeoutMs })` accepts an `AbortSignal`
and defaults to a 30-second deadline, including restart time. `dispose()`
rejects pending work and terminates the client permanently. One job may be
active per worker client; use separate clients for parallel jobs.

Restart policy: the worker is terminated and replaced only when a job times out
or is aborted, when the client is disposed, or when the worker itself fails (a
script load error, an uncaught worker error, an undeliverable message). The next
job then creates a fresh worker from private copies of the original modules.
Ordinary rejections, `TypeError` for invalid input and `CompileError` for schema
errors, traps and budget overruns, keep the worker: every job already runs fresh
guest instances and filesystems, so the next job starts immediately with no
restart and no recompilation.

Runtime policy: worker execution is admitted only where `terminate()` is
verified to stop a running Wasm guest, which today means browsers and exactly
**Deno 2.6.8** (exported as `supportedDenoWorkerVersion`). Other Deno versions,
Bun, Node.js, and unrecognized hosts are rejected before any worker is created,
with an `Error` that points to `createCompiler` for direct execution without a
hard deadline; `isBoundedWorkerSupported()` answers the same question as a
predicate. Deno 2.6.8 deliberately allows a two-second engine termination grace
after `terminate()`; rejection does not mean guest CPU stopped immediately. The
client waits 2.1 seconds before restarting a terminated Deno worker, and
includes that wait in the next job's deadline; disposing the client during that
wait rejects the waiting job at once. The
[runtime evidence](../../docs/deno-worker-termination.md) records a real shared
counter that stops within the grace on 2.6.8 and continues on newer tested
engines. Direct compilation remains tested on the producer's pinned Deno 2.9.6.

Browser workers use no restart delay, but termination is not immediate there
either. WebKit never stops a running Wasm guest on `terminate()`. Chromium stops
it after about 2 s. Firefox is untested. A later change addresses this; until
then, treat a rejected cancellation as a request, not as proof that the guest
stopped.

Worker initialization accepts `{ signal, initTimeoutMs }` alongside `limits`:
the default deadline is 30 seconds, and aborting terminates the starting worker
and rejects the factory with `signal.reason`. Worker script loading is a host
action: to restart completely offline, fetch `worker.js` in advance and use a
blob URL, as the browser test does. Keep that URL alive until the client is
disposed. The SDK does not inject CSP exceptions; the application controls where
workers can be loaded.

## Engine requirements

The compiler modules use standardized WebAssembly exception handling
(`try_table` and `exnref`). Both factories probe for it with
`WebAssembly.validate` before compiling anything and reject with a `TypeError`
that names the requirement when it is missing; `supportsWasmExceptions()` is
exported so applications can gate their UI ahead of time. Approximate first
releases with that support are Chrome 137, Firefox 131, Safari 18.4, and Deno
2.3; the SDK is tested in the pinned Deno, Chromium, Firefox, and WebKit
versions.

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

Limits must be nonnegative safe integers; an `undefined` entry means the
default. Zero disallows the corresponding resource; `memoryPages` instead
accepts 1 through 65,536. Compiler stdout is also bounded by `requestBytes`.
Workspace size is checked before encoding strings, copying byte contents, or
posting a worker message. String contents are measured as UTF-8; returned and
retained bytes remain private snapshots.

Host work that a guest sizes through WASI arguments is bounded by guest memory
rather than by these limits. Read, write, and random-fill requests are checked
against the guest's own memory before any host allocation, so a one-page guest
cannot make the host allocate more than a page; out-of-range pointers and counts
return `EINVAL` to the guest. A command may hold at most 1,024 live descriptors
(`ENFILE` beyond that), which keeps host memory independent of how long a guest
that never closes files runs. These are fixed internal bounds, not options.

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
execution time as well as resources.

Repeated active-worker cancellation stalled in the older tested WebKit revisions
2248 and 2311. The current WebKit 26.6 / revision 2359 passed the same stress
case. The
[browser evidence](../../tests/browser/README.md#engine-regression-evidence)
records this engine comparison; upgrading the test engine does not repair older
installed browsers. Validate the browser versions your application supports.

## Verification

`mise run test:sdk-ts` runs every test file under `sdk/typescript/` on the
pinned Deno using only read permission: direct execution, explicit rejection of
unsupported worker runtimes, exact resource boundaries, oversized sparse output
writes, descriptor renumbering, guest memory growth, input-shape and import-root
validation, engine capability detection (`environment_test.ts`), and hostile
one-page guests that ask the host for oversized reads, random fills, descriptor
floods, out-of-range pointers, and read-only mutations (`host_bounds_test.ts`,
using guests embedded from `tests/browser/guests/`). `mise run test` runs
`sdk_test.ts` as part of the full suite. Running the same command with Deno
2.6.8 enables the worker tests, including `worker_test.ts`: no restart after
ordinary errors, identical error classes and messages in both modes, result
shapes, script load and initialization failures, aborted initialization, and
disposal during the restart wait. CI additionally runs the same suite on Deno
2.6.8 with worker tests enabled plus the external compiler-host package
consumer; the exact lanes are listed in
[CONTRIBUTING.md](../../CONTRIBUTING.md#reproducing-the-ci-lanes). Worker tests
are explicitly ignored on unsupported Deno versions; that does not replace the
required supported-runtime lane. `mise run browser:install` installs the pinned
browsers, then `mise run test:browser` compares every generated byte with native
output in all three engines, blocks network and revokes process permissions
after loading assets, runs the same hostile guests in both modes, and tests
worker cancellation and reuse. See `tests/browser/README.md` for test-host
requirements.
