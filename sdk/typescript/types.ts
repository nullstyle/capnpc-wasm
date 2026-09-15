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
  /** Omitted limits use defaultLimits; zero disallows the corresponding resource. */
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
  /** Ordered include directories within files; searched before includeFiles. Empty means /src. */
  importPaths?: readonly string[];
  /** Strip this directory from requested source names; other files remain relative to /src. */
  sourcePrefix?: string;
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
  outputs: Partial<Record<Language, Record<string, Uint8Array>>>;
  diagnostics: Diagnostic[];
}

export interface CompileResult extends GenerationResult {
  request: Uint8Array;
}

export interface Compiler {
  /** Fresh guest instances and filesystems for every invocation. */
  compile(request: CompileRequest): Promise<CompileResult>;
  /** Generate from a previously compiled request, without running the frontend. */
  generate(request: GenerationRequest): Promise<GenerationResult>;
}

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
