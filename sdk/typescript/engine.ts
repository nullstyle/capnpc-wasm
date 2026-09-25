/**
 * The execution core shared by the public direct compiler and the worker.
 * It runs already-validated jobs on private byte copies; input validation
 * and the caller-facing copies live in mod.ts (direct) and worker-client.ts
 * (worker), so the worker never validates or copies a job twice.
 */
import { compileBounded, inspectModules } from "./wasm.ts";
import { resolveLimits } from "./limits.ts";
import { CommandError, runCommand } from "./runtime.ts";
import { requireWasmExceptions } from "./environment.ts";
import { Cancelled, JobControl } from "./interrupt.ts";
import {
  CompileError,
  type CompileResult,
  type CompilerOptions,
  type Diagnostic,
  type GenerationResult,
  type Language,
  type Modules,
  type ResourceLimits,
} from "./types.ts";

const commands = {
  cpp: "capnpc-c++",
  rust: "capnpc-rust",
  go: "capnpc-go",
  zig: "capnpc-zig",
};

/** A compile job whose byte records are private and already staged by mount. */
export interface StagedCompileJob {
  /** Guest paths under src/ and include/, mapped to private bytes. */
  files: Record<string, Uint8Array>;
  entrypoints: readonly string[];
  importPaths: readonly string[];
  sourcePrefix: string;
  generators: readonly Language[];
}

export interface Engine {
  readonly limits: ResourceLimits;
  /** Generator languages the factory received modules for. */
  readonly supplied: ReadonlySet<Language>;
  /**
   * Run the compiler, then the requested generators, on private inputs. A
   * cancelled job rejects with `control.reason`: a TimeoutError, the abort
   * signal's reason, or an AbortError for a shared-cell cancellation.
   */
  compileStaged(
    job: StagedCompileJob,
    control?: JobControl,
  ): Promise<CompileResult>;
  /** Run generators on a private request buffer. */
  generateStaged(
    request: Uint8Array,
    generators: readonly Language[],
    control?: JobControl,
  ): Promise<GenerationResult>;
}

/** Check the engine and module set, then compile every module once. */
export async function createEngine(
  modules: Modules,
  options: CompilerOptions = {},
): Promise<Engine> {
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
    control: JobControl,
  ) {
    // A deadline or abort that passed between stages stops the job here.
    control.throwIfCancelled();
    let result;
    try {
      // Inputs are private already; the filesystem shares them read-only.
      result = await runCommand(
        module,
        args,
        stdin,
        files,
        readonly,
        limits,
        false,
        control,
      );
    } catch (cause) {
      if (cause instanceof Cancelled) throw cause.reason;
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
    selected: readonly Language[],
    diagnostics: Diagnostic[],
    control: JobControl,
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
        control,
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
    limits,
    supplied,
    async generateStaged(request, selected, control = new JobControl()) {
      return await generate(request, selected, [], control);
    },
    async compileStaged(job, control = new JobControl()) {
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
        job.files,
        true,
        diagnostics,
        control,
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
        ...await generate(
          compiled.stdout,
          job.generators,
          diagnostics,
          control,
        ),
      };
    },
  };
}
