# Threat model

This page states what each host of capnpc-wasm trusts, what it bounds, and what
it leaves to the application. Report gaps against it through
[SECURITY.md](../SECURITY.md). Identifiers such as `TS-03` or `GAP1-02` refer to
findings of the September 2026 quality audit, which is tracked outside this
repository; they mark behavior that is known and not yet changed.

## Trusted and untrusted inputs

Trusted: the Wasm module bytes and standard include schemas an application
supplies (the project's own builds or a verified published archive; hosts check
WASI imports at build time and memory shape at load time, nothing more), the
host runtime (Deno, browser, Go toolchain, Wasmtime), and the application's own
code and configuration.

Untrusted: schema text and binary embeds, `CodeGeneratorRequest` bytes (whether
produced by the compiler or supplied to `generate`), and everything a guest
produces: generated file names and contents, stdout, stderr, and exit codes.
Diagnostics are raw upstream stderr and can contain any bytes a schema author
places in a schema.

Compromised-guest assumption. The guests are upstream C++, Rust, Go, and Zig
programs compiled to Wasm. A malicious schema or request may corrupt a guest's
own linear memory or drive it into any behavior its WASI imports allow. Hosts
therefore treat every guest as hostile from the moment it starts: the sandbox is
the Wasm module boundary plus the WASI surface each host exposes, never the
guest's own validation.

## Boundaries per host

### TypeScript SDK, direct path (`createCompiler`)

- Runs in the calling thread. `browser_wasi_shim` provides WASI over in-memory
  files: the compiler sees read-only `/src` and `/include`; each generator sees
  an empty writable `/`. There is no host filesystem, network, environment, or
  process access; modules must import only `wasi_snapshot_preview1` (checked by
  `tests/toolchain_test.ts`), and the Go generator's two socket imports receive
  no descriptors.
- Bounds: `memoryPages` (the SDK rewrites the module's memory maximum, which is
  why original bytes are required), `workspaceBytes`, `workspaceEntries`,
  `pathBytes`, `requestBytes`, `outputBytes`, `outputEntries`, `stdoutBytes`,
  and `stderrBytes`; defaults are in the
  [SDK guide](../sdk/typescript/README.md#resource-limits). Exceeding a budget
  traps the guest, and no partial result is returned.
- Time: every guest is rewritten with interruption checks before it is compiled,
  so `timeoutMs` (default 30 s) stops a guest that loops, recurses, sleeps in
  `poll_oneoff`, or repeats costly imports or bulk copies: it traps at its
  deadline, and no guest exception handler runs after the stop
  (`sdk/typescript/interrupt_test.ts`, in `mise run test` on every push on Linux
  x64 and macOS arm64 with Deno 2.9.6). A sleeping guest blocks in
  `Atomics.wait` instead of spinning (`GAP2-05`); the Deno tests check that it
  stops at its deadline, and its CPU use was measured locally. The blocked
  thread cannot observe an abort while a guest runs, so an abort takes effect
  before the next guest stage.
- Interruption limits: the rewrite costs about 10 to 16 percent of job time and
  75 ms of factory start-up (measured locally on macOS arm64). A module it
  cannot rewrite exactly (GC types, recursion groups, table initializers, shared
  or 64-bit memory imports, unknown instructions) is rejected with a
  `TypeError`, never run unchecked
  (`SDK instrumentation fails closed on constructs it cannot
  parse exactly`).
  A single import call or bulk operation runs to completion before the next
  check (`random_get` over 256 MiB of memory takes about 0.2 s), and a stop
  recorded while a module's start function runs takes effect at its next poll.

### TypeScript SDK, worker path (`createWorkerCompiler`)

- The same sandbox inside a dedicated worker. `timeoutMs` (default 30 s) and an
  `AbortSignal` reject the job at once and stop the guest inside the worker: the
  worker enforces the deadline itself, and an abort or `dispose()` reaches the
  guest through a shared cell wherever a `SharedArrayBuffer` can cross to the
  worker (Deno, Bun, and cross-origin isolated pages). A timeout, or an abort
  that reaches the guest this way, keeps the worker for the next job, and so do
  ordinary failures (invalid input, schema errors, traps, budget overruns);
  `dispose()`, and an abort without shared memory, terminate it
  (`sdk/typescript/worker_test.ts`:
  `SDK worker cancellation stops the guest and
  keeps its worker`,
  `SDK worker aborts stop bulk operations and costly imports
  inside the guest`,
  `SDK worker keeps its worker after ordinary job errors`, in `mise run test` on
  every push with Deno 2.9.6).
- Runtimes: worker execution is admitted in browsers, on every Deno release, and
  on Bun (releases without standardized Wasm exception handling still fail the
  factories' engine check); Node.js has no Web `Worker` and is rejected. On
  every push CI runs the whole SDK suite on Deno 2.9.6, and on Deno 2.6.8 only
  `sdk_test.ts` and the compiler-host package gate, whose worker timeout and
  abort must stop the guest on the one worker; `mise run test:deno-worker` runs
  the whole suite on 2.6.8, locally and in the held workflows. Bun 1.3.14 was
  verified locally in both modes, not in CI. `terminate()` is only a fallback:
  for a cancelled job that does not report within one second, an abort without
  shared memory, and a failed or disposed worker. It stops nothing in Deno 2.7.6
  and later ([evidence](deno-worker-termination.md)); WebKit stops a guest only
  when the guest calls into JavaScript (`GAP2-V1`), Bun does not stop Wasm
  either, as the audit found (`GAP2-02`), and Chromium stops a guest about two
  seconds later (`GAP2-V3`). Without cross-origin isolation an abort terminates
  the worker: WebKit then stops the instrumented guest at its next poll, which
  calls into JavaScript, and Firefox at once (within 50 ms on Linux, CI
  36117453491), while in Chromium the guest keeps its core until `terminate()`
  stops it or its own `timeoutMs` passes and it traps
  (`SDK worker without SharedArrayBuffer still
  stops guests at their deadline`).
- Browsers: Chromium, Firefox, and WebKit run the offline parity suite, twenty
  alternating abort and timeout cycles with recovery, and a termination
  acceptance that counts a spinning guest's progress in shared memory: after a
  timeout, an abort, and a dispose, both a pure-Wasm and a WASI-calling guest
  must stop within two seconds, and the worker must survive the timeout and the
  abort (`tests/browser/termination.ts` in `test:browser`). They are asserted on
  every push in the Linux `browsers` job, whose first run (CI 36112686931)
  measured 0 to 50 ms in all three engines; Chromium and WebKit on macOS
  measured 0 to 53 ms locally, and the nightly run 36112692524 measured 0 to 185
  ms on macOS.

### Go SDK

- wazero's compiler engine with standardized exception handling. Every command
  gets a fresh module instance and a private in-memory filesystem: read-only
  `/src` and `/include` for the compiler, an empty writable `/` per generator.
  There are no host mounts, symlinks, sockets, environment variables, or
  subprocesses. Modules must export `memory` and a parameterless `_start`.
- Bounds are fixed ([Go guide](../sdk/go/README.md#execution-and-ownership)): 64
  MiB each for workspace, request, generator output, and stdout; 1 MiB stderr;
  4,096 entries and path bytes; 256 MiB of linear memory. Context cancellation
  closes the running module.
- Known gaps: a guest sleeping in `poll_oneoff` ignores the deadline (`GO-01`);
  `Close` and `New` ignore their contexts (`GO-02`, `GO-V2`); a limit breach
  surfaces as an opaque generator failure rather than a named limit (`GO-06`,
  `GAP3-V3`).

### Packaged launcher (`bin/capnp-wasm`)

- Runs
  `wasmtime run -W exceptions=y -W max-wasm-stack=8388608
  -W max-memory-size=268435456 -W timeout=300s -D max-backtrace=16 -S cwd=/
  --dir <root>::/ --argv0 <tool> <module>`
  with exactly one host directory mapped as guest `/`. The compiler's root is a
  fresh write-protected copy of `--workspace` (`/` is refused, `$HOME` warns,
  the copy is bounded); a generator's root is an empty staging directory whose
  files move into `--output` only after exit 0, refusing directory conflicts,
  read-only files, and symlinks at any destination or parent. Wasmtime gives the
  guest no network and the guest environment is empty (`CAPNPC_ZIG_*` produces a
  warning). `CAPNP_WASM_WASMTIME` and `CAPNP_WASM_WASMTIME_ACCEPT_VERSION`,
  which select and accept the runtime, are trusted; `CAPNP_WASM_TIMEOUT`,
  `CAPNP_WASM_MAX_MEMORY`, and `CAPNP_WASM_MAX_WORKSPACE` are validated.
- Memory, stack, and time are bounded by Wasmtime options; a timeout or stack
  exhaustion exits 134 with a bounded backtrace that names only the module
  basename, and memory exhaustion surfaces as the guest's own error. Confinement
  rests on Wasmtime's preopen handling and is covered by regression tests for
  symlink, `..`, and traversal escapes in both modes
  (`tests/package/launcher.ts`); escaping workspace symlinks are reported by a
  launcher warning before the guest fails on them. Package-root resolution
  ignores `CDPATH` and follows symlinks.
- Running as root removes the copy's permission-based read-only guarantee; a
  process killed with SIGKILL can leave a hidden `.capnp-wasm.*` staging
  directory next to `--output` or a `capnp-wasm.*` workspace copy under
  `$TMPDIR`.

### Development runners (`tests/hosts/`)

Trusted staging directories only. The wazero runner's `--dir` grants are
writable and the Deno runner copies created files back to the host. They are
test harnesses, not hosts for untrusted input.

### Schema Studio

A static site that runs the worker SDK in the browser with a 128-file, 8 MiB
workspace limit (512 files and folders combined; the compiler budget adds the
bundled includes). Diagnostics are rendered as text. `index.html` carries a
Content-Security-Policy (scripts from the origin plus a hash for its boot script
and `'wasm-unsafe-eval'`; workers from the origin or blob URLs; no objects, base
URLs, or foreign form targets), and `scripts/serve-example.ts` adds
`frame-ancestors 'none'`, COOP, CORP, `Referrer-Policy: no-referrer`, and a
loopback `Host` allow-list (`SEC-10`); a deployment sends the same headers. ZIP
imports check declared sizes and entry counts before inflating.

### Release integrity

Each archive carries `manifest.json` (per-file SHA-256, source commit and dirty
flag, source digest, and the reference gitlinks), a `provenance/` directory, and
`verify-release.ts`. `SHA256SUMS` lists the archive and manifest digests, and
the digests of every published asset are recorded in
[published releases](releases.md#published-releases). Assets are not signed or
attested and are built by hand from the maintainer's checkout (`SEC-04`). A
party who can replace an asset and its `SHA256SUMS` on the download host can
also recompute the manifest; the copy of the digests in this repository is the
independent check.

## Non-goals

- Bounding total process or JavaScript heap memory. Limits are per workspace and
  per command, and the TypeScript read-side WASI imports can still be driven to
  allocate more than `memoryPages` (`SEC-01`, `TS-03`, `TS-V1`).
- Guaranteeing that a cancelled guest stops consuming CPU on every runtime; see
  the worker path above.
- Defending the host against malicious Wasm modules; modules are trusted inputs.
- Timing and resource-usage side channels.
- Making generated file names safe for every filesystem. The SDKs accept
  canonical relative POSIX paths without `.`, `..`, backslashes, or NUL, and
  otherwise pass guest-chosen names through, including control characters
  (`SEC-05`); the launcher and the SDKs accept different names depending on the
  host filesystem (`GAP3-07`).
- Filtering the content of diagnostics or generated files.

## Guidance for consumers

- Treat stderr and generated file names as untrusted text: escape them before
  rendering HTML, and strip control characters before writing them to a terminal
  or a log.
- Validate output names before writing to disk on Windows or case-insensitive
  filesystems: reserved device names, trailing dots and spaces, case collisions,
  and path-length limits.
- Set deadlines. Use the worker API with `timeoutMs` for untrusted schemas and
  keep the direct path for trusted ones; in Go pass a context with a deadline
  and expect a sleeping guest to ignore it until `GO-01` is fixed.
- Lower the limits to what your inputs need; the defaults allow 64 MiB
  workspaces and outputs per job.
- Pin the archive digests from the published releases table, run
  `verify-release.ts` before use, and load module bytes only from that verified
  package.
- Generate into fresh directories and publish only after success. The launcher
  copies the workspace and publishes generator output only after exit 0; SDK
  callers keep this discipline themselves.
- In browsers, keep the worker script URL alive for restarts and serve the
  application with a Content-Security-Policy that allows worker creation and
  Wasm compilation only from your origin.

## Known gaps

| Area                                    | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Audit ids                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| TypeScript memory bounds                | Read-side WASI imports and open descriptors can exceed `memoryPages`                                                                                                                                                                                                                                                                                                                                                                                     | `SEC-01`, `TS-03`, `TS-V1`                      |
| Execution deadlines                     | Resolved where a test asserts the bound: Deno 2.9.6 on every push (both paths), Deno 2.6.8 on every push (`sdk_test.ts` and the compiler-host gate), Chromium, Firefox, and WebKit on Linux on every push (0 to 50 ms in CI 36112686931), Chromium and WebKit on macOS locally                                                                                                                                                                           | `SEC-03`, `TS-13`, `GAP2-V1`, `GAP2-02` (fixed) |
| Cancellation residuals                  | Without cross-origin isolation an aborted guest can run until `terminate()` stops it or its `timeoutMs` passes (about 2 s in Chromium); `terminate()` remains the fallback; Bun is verified locally only; one import call or bulk operation runs to completion; the rewrite costs 10 to 16 percent of job time and rejects modules it cannot rewrite exactly; one soak recovery in WebKit on Linux stalled for 30 s (nightly 36112692524), cause unknown | `GAP2-V1`, `GAP2-02`, `GAP2-V3`                 |
| Worker restart                          | Resolved: ordinary failures, timeouts, and aborts with shared memory keep the worker; `terminate()` is a fallback                                                                                                                                                                                                                                                                                                                                        | `TS-01`, `GAP2-V2` (fixed)                      |
| Go deadlines and shutdown               | Sleeping guests ignore deadlines; `Close` and `New` ignore contexts                                                                                                                                                                                                                                                                                                                                                                                      | `GO-01`, `GO-02`, `GO-V2`                       |
| Launcher output and inputs              | Resolved: staged output and a read-only workspace copy; `/` refused                                                                                                                                                                                                                                                                                                                                                                                      | `GAP1-01`, `GAP1-02` (fixed)                    |
| Launcher ceilings and confinement tests | Resolved: 256 MiB, 8 MiB stack, 300 s bounds; escape regression tests; symlink warning                                                                                                                                                                                                                                                                                                                                                                   | `SEC-02`, `SEC-07`, `GAP1-V2` (fixed)           |
| Launcher invocation                     | Resolved: `CDPATH`-safe, symlink-resolving, executable with `package.json` `bin`                                                                                                                                                                                                                                                                                                                                                                         | `SEC-06`, `GAP1-V1` (fixed)                     |
| Release trust                           | Unsigned, hand-built assets; CI token and download hardening                                                                                                                                                                                                                                                                                                                                                                                             | `SEC-04`, `SEC-08`                              |
| Names and diagnostics                   | Control characters pass through; host filesystems differ                                                                                                                                                                                                                                                                                                                                                                                                 | `SEC-05`, `GAP3-07`                             |
