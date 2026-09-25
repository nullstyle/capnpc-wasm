/** Per-job host budgets and a per-instance guest linear-memory ceiling. */
export const defaultLimits = Object.freeze({
  memoryPages: 4096,
  workspaceBytes: 64 * 1024 * 1024,
  workspaceEntries: 4096,
  pathBytes: 4096,
  requestBytes: 64 * 1024 * 1024,
  outputBytes: 64 * 1024 * 1024,
  outputEntries: 4096,
  stdoutBytes: 64 * 1024 * 1024,
  stderrBytes: 1024 * 1024,
});
export type ResourceLimits = {
  -readonly [Name in keyof typeof defaultLimits]: number;
};

export type Language = "cpp" | "rust" | "go" | "zig";
export type Files = Readonly<Record<string, string | Uint8Array>>;
/** Original Wasm bytes; opaque compiled modules cannot be memory-bounded. */
export type WasmModule = Uint8Array;

/** Resource policy shared by direct and worker compiler factories. */
export interface CompilerOptions {
  /** Omitted or undefined limits use defaultLimits; zero disallows the corresponding resource. */
  limits?: Partial<ResourceLimits>;
}

/** Supply already-loaded module bytes; SDK execution never fetches dependencies. */
export interface Modules {
  compiler: WasmModule;
  generators: Partial<Record<Language, WasmModule>>;
}

export interface CompileRequest {
  /** Canonical, case-sensitive relative POSIX paths, staged beneath /src. */
  files: Files;
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

export interface Diagnostic {
  stage: "compiler" | Language;
  /** Unmodified guest stderr; source locations are not inferred. */
  stderr: string;
}

export interface GenerationRequest {
  /** One unpacked CodeGeneratorRequest, at most requestBytes (default 64 MiB). */
  request: Uint8Array;
  /** At least one generator is required for standalone generation. */
  generators: readonly Language[];
}

export interface GenerationResult {
  /**
   * Plain objects keyed by language, then by the generator's relative output
   * path. Output names are guest-chosen own properties; enumerate them with
   * Object.keys/entries rather than `for...in` with inherited lookups.
   */
  outputs: Partial<Record<Language, Record<string, Uint8Array>>>;
  /** Every stage's stderr, in execution order, including successful stages. */
  diagnostics: Diagnostic[];
}

export interface CompileResult extends GenerationResult {
  request: Uint8Array;
}

/**
 * Per-job cancellation, accepted by both execution modes. Every guest runs
 * with injected interruption checks, so a timeout or abort stops the guest
 * itself with a trap, not only the returned promise.
 */
export interface JobOptions {
  /**
   * Aborting rejects the job with `signal.reason`. A worker job's guest stops
   * within milliseconds where SharedArrayBuffer is available (Deno, and
   * cross-origin isolated pages); elsewhere the worker is terminated, and
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

export interface Compiler {
  /** Fresh guest instances and filesystems for every invocation. */
  compile(
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
export type FailureKind = "exit" | "trap" | "limit" | "protocol";

/** Options for CompileError beyond ErrorOptions. */
export interface CompileErrorOptions extends ErrorOptions {
  /** Defaults to `exit` when an exit code is given, else `trap`. */
  kind?: FailureKind;
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
export class CompileError extends Error {
  override readonly name = "CompileError";
  readonly kind: FailureKind;
  /** The ResourceLimits budget a running guest exceeded, for kind `limit`. */
  readonly limit?: keyof ResourceLimits;
  constructor(
    message: string,
    public readonly stage: "compiler" | Language,
    public readonly diagnostics: readonly Diagnostic[],
    public readonly exitCode?: number,
    options?: CompileErrorOptions,
  ) {
    super(message, options);
    this.kind = options?.kind ?? (exitCode === undefined ? "trap" : "exit");
    if (options?.limit !== undefined) this.limit = options.limit;
  }
}
