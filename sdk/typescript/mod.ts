import { compileBounded } from "./wasm.ts";
import {
  checkPath,
  copyFiles,
  resolveLimits,
  validateGeneration,
  validateWorkspace,
} from "./limits.ts";
import { CommandError, runCommand } from "./runtime.ts";
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
  supportedDenoWorkerVersion,
  type WorkerCompiler,
} from "./worker-client.ts";

const languages: readonly Language[] = ["cpp", "rust", "go", "zig"];
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
  const limits = resolveLimits(options);
  const compiler = await compileBounded(modules.compiler, limits.memoryPages);
  const generators = new Map<Language, WebAssembly.Module>();
  for (const [language, module] of Object.entries(modules.generators)) {
    if (!languages.includes(language as Language)) {
      throw new TypeError(`unknown generator: ${language}`);
    }
    if (module !== undefined) {
      generators.set(
        language as Language,
        await compileBounded(module, limits.memoryPages),
      );
    }
  }

  function targets(requested: readonly Language[]): Language[] {
    if (requested.length > 4) throw new TypeError("too many generators");
    const selected = [...requested];
    if (new Set(selected).size !== selected.length) {
      throw new TypeError("duplicate generators");
    }
    for (const target of selected) {
      if (!generators.has(target)) {
        throw new TypeError(`generator was not supplied: ${target}`);
      }
    }
    return selected;
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
    const outputs: GenerationResult["outputs"] = Object.create(null);
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
      const selected = targets(input.generators);
      if (selected.length === 0) {
        throw new TypeError("at least one generator is required");
      }
      const request = validateGeneration(input, limits);
      return await generate(new Uint8Array(request), selected, []);
    },
    async compile(input: CompileRequest): Promise<CompileResult> {
      // Snapshot and validate the whole job before yielding to guest execution.
      const [sources, annotations] = validateWorkspace(input, limits);
      const files = copyFiles(sources, "src/");
      const includes = copyFiles(annotations, "include/");
      const entrypoints = [...input.entrypoints];
      const selected = targets(input.generators);
      if (entrypoints.length === 0) {
        throw new TypeError("at least one entrypoint is required");
      }
      for (const path of entrypoints) {
        checkPath(path, limits);
        if (!Object.hasOwn(files, `src/${path}`)) {
          throw new TypeError(`entrypoint is not in files: ${path}`);
        }
      }
      if (new Set(entrypoints).size !== entrypoints.length) {
        throw new TypeError("duplicate entrypoints");
      }
      const diagnostics: Diagnostic[] = [];
      const compiled = await execute(
        "compiler",
        compiler,
        [
          "capnp",
          "compile",
          "--no-standard-import",
          "-I/include",
          "--src-prefix=/src",
          "-o-",
          ...entrypoints.map((path) => `/src/${path}`),
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
      if (compiled.stdout.length > limits.requestBytes) {
        throw new CompileError(
          "compiler request exceeds requestBytes limit",
          "compiler",
          diagnostics,
        );
      }
      return {
        request: compiled.stdout,
        ...await generate(compiled.stdout, selected, diagnostics),
      };
    },
  };
}
