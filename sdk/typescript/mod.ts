import { createEngine } from "./engine.ts";
import { JobControl, jobOptions } from "./interrupt.ts";
import { copyFiles, validateCompile, validateGenerate } from "./limits.ts";
import type {
  Compiler,
  CompileRequest,
  CompileResult,
  CompilerOptions,
  GenerationRequest,
  GenerationResult,
  JobOptions,
  Modules,
} from "./types.ts";

export * from "./types.ts";
export {
  createWorkerCompiler,
  type WorkerCompiler,
  type WorkerCompilerOptions,
} from "./worker-client.ts";
export {
  isBoundedWorkerSupported,
  supportedDenoWorkerVersion,
  supportsWasmExceptions,
} from "./environment.ts";

/**
 * Compile the supplied modules once, then run disk-free jobs in this JS thread.
 * Guest execution is synchronous; browsers should use createWorkerCompiler.
 * Each job's `timeoutMs` (30 s by default) is enforced inside the guest, so
 * a runaway guest traps instead of blocking the thread past its deadline.
 */
export async function createCompiler(
  modules: Modules,
  options: CompilerOptions = {},
): Promise<Compiler> {
  const engine = await createEngine(modules, options);
  const control = ({ signal, timeoutMs }: ReturnType<typeof jobOptions>) =>
    new JobControl({ deadline: performance.now() + timeoutMs, signal });
  return {
    async generate(
      input: GenerationRequest,
      options?: JobOptions,
    ): Promise<GenerationResult> {
      const settings = jobOptions(options);
      const job = validateGenerate(input, engine.limits, engine.supplied);
      return await engine.generateStaged(
        new Uint8Array(job.request),
        job.generators,
        control(settings),
      );
    },
    async compile(
      input: CompileRequest,
      options?: JobOptions,
    ): Promise<CompileResult> {
      const settings = jobOptions(options);
      // Snapshot and validate the whole job before yielding to guest execution.
      const job = validateCompile(input, engine.limits, engine.supplied);
      const files: Record<string, Uint8Array> = Object.assign(
        Object.create(null),
        copyFiles(job.sources, "src/"),
        copyFiles(job.annotations, "include/"),
      );
      return await engine.compileStaged({
        files,
        entrypoints: job.entrypoints,
        importPaths: job.importPaths,
        sourcePrefix: job.sourcePrefix,
        generators: job.generators,
      }, control(settings));
    },
  };
}
