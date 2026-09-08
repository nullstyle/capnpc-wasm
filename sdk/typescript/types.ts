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

export interface GenerationRequest {
  /** One unpacked CodeGeneratorRequest, at most 64 MiB. */
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
