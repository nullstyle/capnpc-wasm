/** Per-job host budgets and a per-instance guest linear-memory ceiling. */
declare const defaultLimits: Readonly<
  {
    memoryPages: 4096;
    workspaceBytes: number;
    workspaceEntries: 4096;
    pathBytes: 4096;
    requestBytes: number;
    outputBytes: number;
    outputEntries: 4096;
    stdoutBytes: number;
    stderrBytes: number;
  }
>;
type ResourceLimits = {
  -readonly [Name in keyof typeof defaultLimits]: number;
};
type Language = "cpp" | "rust" | "go" | "zig";
type Files = Readonly<Record<string, string | Uint8Array>>;
/** Original Wasm bytes; opaque compiled modules cannot be memory-bounded. */
type WasmModule = Uint8Array;
/** Resource policy shared by direct and worker compiler factories. */
interface CompilerOptions {
  /** Omitted or undefined limits use defaultLimits; zero disallows the corresponding resource. */
  limits?: Partial<ResourceLimits>;
}
/** Supply already-loaded module bytes; SDK execution never fetches dependencies. */
interface Modules {
  compiler: WasmModule;
  generators: Partial<Record<Language, WasmModule>>;
}
interface CompileRequest {
  /** Canonical, case-sensitive relative POSIX paths, staged beneath /src. */ files:
    Files;
  /** Standard schemas and annotations, staged beneath /include. */
  includeFiles?: Files;
  /**
   * Ordered directories within `files`, searched for absolute imports before
   * includeFiles. An omitted or empty list adds no roots; the element `""`
   * names the /src root itself. Every other entry must be a directory implied
   * by a path in `files`.
   */
  importPaths?: readonly string[];
  /**
   * Strip this directory of `files` from requested source names; other files
   * remain relative to /src. `""` (the default) keeps names relative to /src.
   */
  sourcePrefix?: string;
  /** Paths present in `files`; at least one is required. */
  entrypoints: readonly string[];
  /** An empty list compiles to a request without generating source. */
  generators: readonly Language[];
}
interface Diagnostic {
  stage: "compiler" | Language;
  /** Unmodified guest stderr; source locations are not inferred. */
  stderr: string;
}
interface GenerationRequest {
  /** One unpacked CodeGeneratorRequest, at most requestBytes (default 64 MiB). */ request:
    Uint8Array;
  /** At least one generator is required for standalone generation. */
  generators: readonly Language[];
}
interface GenerationResult {
  /** * Plain objects keyed by language, then by the generator's relative output * path. Output names are guest-chosen own properties; enumerate them with
   * Object.keys/entries rather than `for...in` with inherited lookups.
   */
  outputs: Partial<Record<Language, Record<string, Uint8Array>>>;
  /** Every stage's stderr, in execution order, including successful stages. */
  diagnostics: Diagnostic[];
}
interface CompileResult extends GenerationResult {
  request: Uint8Array;
}
/**
 * Per-job cancellation, accepted by both execution modes. Every guest runs
 * with injected interruption checks, so a timeout or abort stops the guest
 * itself with a trap, not only the returned promise.
 */
interface JobOptions {
  /** * Aborting rejects the job with `signal.reason`. A worker job's guest stops * within milliseconds where SharedArrayBuffer is available (Deno, and * cross-origin isolated pages); elsewhere the worker is terminated, and
   * the guest still stops at `timeoutMs` in engines where termination does
   * not stop it. A direct job runs its guests on the calling thread, which
   * cannot observe the signal until the running guest stage ends, so the
   * abort takes effect before the next stage and `timeoutMs` bounds the rest.
   */
  signal?: AbortSignal;
  /**
   * Milliseconds until the job rejects with a `TimeoutError` DOMException and
   * its guest traps at its next check. Defaults to 30000; worker jobs include
   * any wait for a worker to start or recover.
   */
  timeoutMs?: number;
}
interface Compiler {
  /** Fresh guest instances and filesystems for every invocation. */ compile(
    request: CompileRequest,
    options?: JobOptions,
  ): Promise<CompileResult>;
  /** Generate from a previously compiled request, without running the frontend. */
  generate(
    request: GenerationRequest,
    options?: JobOptions,
  ): Promise<GenerationResult>;
}
/**
 * How a guest stage failed, as CompileError.kind:
 * - `exit`: the stage exited nonzero; `exitCode` holds the status.
 * - `trap`: the guest trapped, or the host failed inside a WASI import.
 * - `limit`: a running guest exceeded the host budget named by `limit`.
 * - `protocol`: the stage exited 0 without honoring its contract (the
 *   compiler emitted no request, or a generator wrote to stdout).
 * The Go SDK's `*Error` maps the same way: `Limit != ""` is a limit,
 * `ExitCode != 0` an exit, the two contract messages a protocol failure,
 * and anything else a trap.
 */
type FailureKind = "exit" | "trap" | "limit" | "protocol";
/** Options for CompileError beyond ErrorOptions. */
interface CompileErrorOptions extends ErrorOptions {
  /** Defaults to `exit` when an exit code is given, else `trap`. */ kind?:
    FailureKind;
  /** The exceeded budget, for kind `limit`. */
  limit?: keyof ResourceLimits;
}
/**
 * A guest stage failed: a nonzero exit (`exitCode` set), a trap, a host
 * budget from ResourceLimits exceeded while the guest ran (`limit` names it;
 * the message names it too), or a broken stage contract; `kind` says which,
 * and `cause` carries the underlying error. Identical in direct and worker
 * execution.
 */
declare class CompileError extends Error {
  readonly stage: "compiler" | Language;
  readonly diagnostics: readonly Diagnostic[];
  readonly exitCode?: number;
  readonly name = "CompileError";
  readonly kind: FailureKind;
  /** The ResourceLimits budget a running guest exceeded, for kind `limit`. */
  readonly limit?: keyof ResourceLimits;
  constructor(
    message: string,
    stage: "compiler" | Language,
    diagnostics: readonly Diagnostic[],
    exitCode?: number,
    options?: CompileErrorOptions,
  );
}
/**
 * Engine and host-runtime checks shared by both compiler factories. Failing
 * early here turns opaque engine parse errors and hosts without a usable
 * Worker into actionable errors before any module is compiled.
 */
/**
 * The one Deno release whose `Worker.terminate()` stopped a running guest,
 * which worker execution required before guests were instrumented with
 * interruption checks.
 * @deprecated Worker execution no longer depends on the Deno release: every
 * guest stops itself at its deadline or when its job is cancelled. The SDK no
 * longer checks this value; it will be removed.
 */
declare const supportedDenoWorkerVersion = "2.6.8";
/**
 * Whether this engine validates the standardized Wasm exception-handling
 * instructions (`try_table`, `exnref`) that the C++ compiler modules use.
 * Approximate first releases: Chrome 137, Firefox 131, Safari 18.4, Deno 2.3.
 */
declare function supportsWasmExceptions(): boolean;
declare function requireWasmExceptions(): void;
type WorkerRuntime = { kind: "deno"; version: string } | {
  kind: "browser";
} | {
  kind: "bun";
} | {
  kind: "node";
} | {
  kind: "unknown";
};
/** Classify the host from its globals; injectable for tests. */
declare function detectWorkerRuntime(
  globals?: Record<string, unknown>,
): WorkerRuntime;
/**
 * Admit worker execution where a module Worker runs the SDK's worker script:
 * browsers, Deno and Bun. Cancellation does not depend on the host's
 * `terminate()`: every guest stops itself at its deadline or, where a
 * SharedArrayBuffer reaches the worker, when its job is cancelled.
 */
declare function checkWorkerRuntime(
  globals?: Record<string, unknown>,
): { runtime: WorkerRuntime };
/**
 * Whether createWorkerCompiler would be admitted on this host: browsers, Deno
 * and Bun. Applications use it to choose between worker execution and
 * createCompiler without rehearsing the rejection.
 */
declare function isBoundedWorkerSupported(
  globals?: Record<string, unknown>,
): boolean;
interface WorkerCompilerOptions extends CompilerOptions {
  /** Aborts worker start-up: the worker is terminated and the factory rejects. */ signal?:
    AbortSignal;
  /** Milliseconds allowed for the worker to load and compile every module. Defaults to 30000. */
  initTimeoutMs?: number;
}
interface WorkerCompiler {
  /** * One active job per client. Cancellation stops the job's guest inside the * worker, which then serves the next job unless it had to be terminated;
   * see createWorkerCompiler.
   */
  compile(
    request: CompileRequest,
    options?: JobOptions,
  ): Promise<CompileResult>;
  generate(
    request: GenerationRequest,
    options?: JobOptions,
  ): Promise<GenerationResult>;
  /** Stop any running guest, terminate the worker, and reject pending work. */
  dispose(): void;
  /** The same as dispose(), for `using` on engines that provide Symbol.dispose. */
  [Symbol.dispose](): void;
}
/**
 * Resolve once, at creation, so restarts never re-resolve a relative URL
 * against a document base that moved. Relative strings resolve the way a
 * plain `new Worker(string)` would: against `document.baseURI` (which honours
 * `<base href>`), else the location. Injectable for tests.
 */
declare function resolveWorkerURL(
  workerURL: string | URL,
  globals?: {
    document?: { baseURI?: string };
    location?: {
      href?: string;
    };
  },
): URL;
/**
 * Worker entrypoint must be the built worker.js, served locally or as a blob.
 *
 * Cancellation (a timeout, an abort, or dispose) rejects the job at once and
 * stops its guest from inside: where a SharedArrayBuffer can reach the worker,
 * the client stores the job's id in a shared cell, and the guest traps at its
 * next interruption check; a timeout also trips the deadline the worker
 * enforces itself. Unless it is terminated, the worker then serves the next
 * job, which first waits for the cancelled one to report. The worker is
 * terminated and replaced only as a fallback: when a cancelled job does not
 * report within a second, when an abort cannot reach the guest (no
 * SharedArrayBuffer; the guest still stops at its own deadline where
 * terminate() does not stop it), when start-up is cancelled, when the worker
 * itself fails (`error` or `messageerror` events, or `postMessage` throwing),
 * and on dispose.
 * Ordinary rejections (`TypeError` for bad input, `CompileError` for guest
 * failures, including traps and limits) keep the worker, because every job
 * runs fresh guest instances and filesystems.
 */
declare function createWorkerCompiler(
  workerURL: string | URL,
  modules: Modules,
  options?: WorkerCompilerOptions,
): Promise<WorkerCompiler>;
/**
 * Compile the supplied modules once, then run disk-free jobs in this JS thread.
 * Guest execution is synchronous; browsers should use createWorkerCompiler.
 * Each job's `timeoutMs` (30 s by default) is enforced inside the guest, so
 * a runaway guest traps instead of blocking the thread past its deadline.
 */
declare function createCompiler(
  modules: Modules,
  options?: CompilerOptions,
): Promise<Compiler>;

export {
  CompileError,
  CompileErrorOptions,
  Compiler,
  CompileRequest,
  CompileResult,
  CompilerOptions,
  createCompiler,
  createWorkerCompiler,
  defaultLimits,
  Diagnostic,
  FailureKind,
  Files,
  GenerationRequest,
  GenerationResult,
  isBoundedWorkerSupported,
  JobOptions,
  Language,
  Modules,
  ResourceLimits,
  supportedDenoWorkerVersion,
  supportsWasmExceptions,
  WasmModule,
  WorkerCompiler,
  WorkerCompilerOptions,
};
