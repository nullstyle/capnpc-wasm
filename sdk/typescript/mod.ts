import { compileBounded, inspectModules } from "./wasm.ts";
import {
  copyFiles,
  resolveLimits,
  validateCompile,
  validateGenerate,
} from "./limits.ts";
import { CommandError, runCommand } from "./runtime.ts";
import { requireWasmExceptions } from "./environment.ts";
import {
  CompileError,
  type Compiler,
  type CompileRequest,
  type CompileResult,
  type CompilerOptions,
  type Diagnostic,
  type GenerationRequest,
  type GenerationResult,
  type Language,
  type Modules,
} from "./types.ts";

export * from "./types.ts";
export {
  createWorkerCompiler,
  type JobOptions,
  type WorkerCompiler,
  type WorkerCompilerOptions,
} from "./worker-client.ts";
export {
  supportedDenoWorkerVersion,
  supportsWasmExceptions,
} from "./environment.ts";

const commands = {
  cpp: "capnpc-c++",
  rust: "capnpc-rust",
  go: "capnpc-go",
  zig: "capnpc-zig",
};

/**
 * Compile the supplied modules once, then run disk-free jobs in this JS thread.
 * Guest execution is synchronous; browsers should use createWorkerCompiler.
 */
export async function createCompiler(
  modules: Modules,
  options: CompilerOptions = {},
): Promise<Compiler> {
  requireWasmExceptions();
  const limits = resolveLimits(options);
  const supplied = new Set(inspectModules(modules, limits.memoryPages));
  const compiler = await compileBounded(modules.compiler, limits.memoryPages);
  const generators = new Map<Language, WebAssembly.Module>();
  for (const language of supplied) {
    generators.set(
      language,
      await compileBounded(modules.generators[language]!, limits.memoryPages),
    );
  }

  async function execute(
    stage: "compiler" | Language,
    module: WebAssembly.Module,
    args: string[],
    stdin: Uint8Array,
    files: Record<string, Uint8Array>,
    readonly: boolean,
    diagnostics: Diagnostic[],
  ) {
    let result;
    try {
      result = await runCommand(module, args, stdin, files, readonly, limits);
    } catch (cause) {
      if (cause instanceof CommandError && cause.stderr) {
        diagnostics.push({ stage, stderr: cause.stderr });
      }
      throw new CompileError(
        `${stage} trapped: ${cause instanceof Error ? cause.message : cause}`,
        stage,
        diagnostics,
        undefined,
        { cause },
      );
    }
    if (result.stderr) diagnostics.push({ stage, stderr: result.stderr });
    if (result.code !== 0) {
      throw new CompileError(
        `${stage} exited with status ${result.code}`,
        stage,
        diagnostics,
        result.code,
      );
    }
    return result;
  }

  async function generate(
    request: Uint8Array,
    selected: Language[],
    diagnostics: Diagnostic[],
  ): Promise<GenerationResult> {
    // Plain objects in both execution modes; language keys are SDK-chosen.
    const outputs: GenerationResult["outputs"] = {};
    for (const language of selected) {
      const generated = await execute(
        language,
        generators.get(language)!,
        [commands[language]],
        request,
        {},
        false,
        diagnostics,
      );
      if (generated.stdout.length !== 0) {
        throw new CompileError(
          `${language} generator unexpectedly wrote to stdout`,
          language,
          diagnostics,
        );
      }
      outputs[language] = generated.files;
    }
    return { outputs, diagnostics };
  }

  return {
    async generate(input: GenerationRequest): Promise<GenerationResult> {
      const job = validateGenerate(input, limits, supplied);
      return await generate(new Uint8Array(job.request), job.generators, []);
    },
    async compile(input: CompileRequest): Promise<CompileResult> {
      // Snapshot and validate the whole job before yielding to guest execution.
      const job = validateCompile(input, limits, supplied);
      const files = copyFiles(job.sources, "src/");
      const includes = copyFiles(job.annotations, "include/");
      const diagnostics: Diagnostic[] = [];
      const compiled = await execute(
        "compiler",
        compiler,
        [
          "capnp",
          "compile",
          "--no-standard-import",
          ...job.importPaths.map((path) => path ? `-I/src/${path}` : "-I/src"),
          "-I/include",
          "--src-prefix=/src",
          ...(job.sourcePrefix
            ? [`--src-prefix=/src/${job.sourcePrefix}`]
            : []),
          "-o-",
          ...job.entrypoints.map((path) => `/src/${path}`),
        ],
        new Uint8Array(),
        { ...files, ...includes },
        true,
        diagnostics,
      );
      if (compiled.stdout.length === 0) {
        throw new CompileError(
          "compiler emitted no request",
          "compiler",
          diagnostics,
        );
      }
      // runCommand bounds compiler stdout at requestBytes while the guest
      // runs, so an oversized request already failed as a CompileError.
      return {
        request: compiled.stdout,
        ...await generate(compiled.stdout, job.generators, diagnostics),
      };
    },
  };
}
