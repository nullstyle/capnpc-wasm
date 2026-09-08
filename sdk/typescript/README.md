# Browser and Deno SDK

The SDK compiles schemas and generates C++, Rust, Go, and Zig from supplied Wasm
modules. It performs no filesystem or network operations. Build it with
`mise run build:sdk`: `dist/typescript/mod.js` is a standalone ES module with
TypeScript declarations, and `worker.js` is its bundled worker entrypoint.
`dist/wasm/` contains the same command binaries used by the native host tests;
`dist/include/` contains pinned standard schemas and language annotations.

The caller loads only the generators it needs, using its own asset URLs,
embedded bytes, or cache. Modules can be bytes or compiled `WebAssembly.Module`
objects. No runtime imports point into `ref/` or to a CDN.

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

See `examples/browser/` for a worker example with language selection and file
downloads, and `examples/deno.ts` for a Deno example. Run
`mise run example:browser` and open its HTTP URL; opening the HTML file directly
shows launch instructions. The server only delivers static files; schema
compilation runs in the browser.

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
available generator and nonempty unpacked request bytes, up to 64 MiB. Request
bytes are copied before execution; generators validate their contents and report
malformed requests through `CompileError`. All requested generators must succeed
before outputs are returned. Worker `generate` accepts the same signal and
timeout options as `compile`, and shares its one-active-job limit. Cache
requests only alongside the toolchain revision and the full schema/include
workspace they represent.

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

`createCompiler(modules)` compiles modules once and runs jobs in the current JS
thread. Its interface is asynchronous, but each guest's execution blocks that
thread. This works in Deno and application-owned workers; it has no hard
timeout.

`createWorkerCompiler(workerURL, modules)` executes off the main thread. Its
`compile(request, { signal, timeoutMs })` accepts an `AbortSignal` and defaults
to a 30-second deadline, including restart time. Aborting or timing out
terminates the worker and rejects the job. The next job creates a fresh worker
using private copies of the original modules. `dispose()` rejects pending work
and terminates the client permanently. One job may be active per worker client;
use separate clients for parallel jobs.

Worker initialization also has a 30-second timeout. Worker script loading is a
host action: to restart completely offline, fetch `worker.js` in advance and use
a blob URL, as the browser test does. Keep that URL alive until the client is
disposed. The SDK does not inject CSP exceptions; the application controls where
workers can be loaded.

This first SDK is tested in the pinned Deno, Chromium, Firefox, and WebKit
versions. The C++ modules require standardized Wasm exception handling. Worker
termination bounds execution time, but this adapter does not yet enforce hard
guest-memory or output-byte budgets; use the pinned trusted guest modules and
size application workspaces appropriately.

## Verification

`mise run test` runs the Deno SDK tests using only read permission, including
infinite-Wasm cancellation and recovery. `mise run browser:install` installs the
pinned browsers, then `mise run test:browser` compares every generated byte with
native output in all three engines, blocks network and revokes process
permissions after loading assets, and tests worker cancellation and reuse. See
`tests/browser/README.md` for test-host requirements.
