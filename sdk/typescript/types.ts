export type Language = "cpp" | "rust" | "go";
export type Files = Readonly<Record<string, string | Uint8Array>>;
export type WasmModule = Uint8Array | WebAssembly.Module;

/** Supply already-loaded modules; SDK execution never fetches dependencies. */
export interface Modules {
  compiler: WasmModule;
  generators: Partial<Record<Language, WasmModule>>;
}

export interface CompileRequest {
  /** Canonical, case-sensitive relative POSIX paths, staged beneath /src. */
  files: Files;
  /** Standard schemas and annotations, staged beneath /include. */
  includeFiles?: Files;
  entrypoints: readonly string[];
  /** An empty list compiles to a request without generating source. */
  generators: readonly Language[];
}

export interface Diagnostic {
  stage: "compiler" | Language;
  /** Unmodified guest stderr; source locations are not inferred. */
  stderr: string;
}

export interface CompileResult {
  request: Uint8Array;
  outputs: Partial<Record<Language, Record<string, Uint8Array>>>;
  diagnostics: Diagnostic[];
}

export interface Compiler {
  /** Fresh guest instances and filesystems for every invocation. */
  compile(request: CompileRequest): Promise<CompileResult>;
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
