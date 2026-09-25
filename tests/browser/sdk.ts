// The SDK's public types for the browser driver, imported with `import type`
// so the driver is checked against the real API (ARCH-13) and the imports are
// erased: nothing here reaches the offline browser boundary.
//
// The worker client's interface is written out here because worker-client.ts
// reaches the reference WASI shim's non-strict sources, which the driver's
// strict type check cannot load. sdk/typescript/conformance_test.ts, checked
// with the SDK's own configuration, asserts that these two copies and the
// SDK's are the same types, so neither can drift.
import type {
  CompileRequest,
  CompileResult,
  GenerationRequest,
  GenerationResult,
} from "../../sdk/typescript/types.ts";

export type {
  CompileError,
  Compiler,
  CompileRequest,
  CompileResult,
  CompilerOptions,
  Files,
  GenerationRequest,
  GenerationResult,
  Language,
  Modules,
  ResourceLimits,
} from "../../sdk/typescript/types.ts";

export interface JobOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface WorkerCompiler {
  compile(
    request: CompileRequest,
    options?: JobOptions,
  ): Promise<CompileResult>;
  generate(
    request: GenerationRequest,
    options?: JobOptions,
  ): Promise<GenerationResult>;
  dispose(): void;
  [Symbol.dispose](): void;
}
