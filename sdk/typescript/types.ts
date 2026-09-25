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
 * A guest stage failed: a nonzero exit (`exitCode` set), a trap, or a host
 * budget from ResourceLimits exceeded while the guest ran (the message names
 * the limit; `cause` carries the underlying error). Identical in direct and
 * worker execution.
 */
export class CompileError extends Error {
  override readonly name = "CompileError";
  constructor(
    message: string,
    public readonly stage: "compiler" | Language,
    public readonly diagnostics: readonly Diagnostic[],
    public readonly exitCode?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
