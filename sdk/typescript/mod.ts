import { CommandError, runCommand } from "./runtime.ts";
import {
  CompileError,
  type Compiler,
  type CompileRequest,
  type CompileResult,
  type Diagnostic,
  type Files,
  type Language,
  type Modules,
  type WasmModule,
} from "./types.ts";

export * from "./types.ts";
export { createWorkerCompiler, type WorkerCompiler } from "./worker-client.ts";

const languages: readonly Language[] = ["cpp", "rust", "go"];
const commands = { cpp: "capnpc-c++", rust: "capnpc-rust", go: "capnpc-go" };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function checkPath(path: string): void {
  if (
    typeof path !== "string" || /[\\\0]/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    decoder.decode(encoder.encode(path)) !== path
  ) throw new TypeError(`expected a canonical relative POSIX path: ${path}`);
}

function snapshot(files: Files, prefix: string): Record<string, Uint8Array> {
  const result: Record<string, Uint8Array> = Object.create(null);
  const names = new Set(Object.keys(files));
  for (const [path, contents] of Object.entries(files)) {
    checkPath(path);
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (names.has(parts.slice(0, i).join("/"))) {
        throw new TypeError(`file/directory collision: ${path}`);
      }
    }
    if (typeof contents !== "string" && !(contents instanceof Uint8Array)) {
      throw new TypeError(`expected text or bytes for ${path}`);
    }
    result[`${prefix}/${path}`] = typeof contents === "string"
      ? encoder.encode(contents)
      : new Uint8Array(contents);
  }
  return result;
}

async function compileModule(module: WasmModule): Promise<WebAssembly.Module> {
  return module instanceof WebAssembly.Module
    ? module
    : await WebAssembly.compile(new Uint8Array(module));
}

/**
 * Compile the supplied modules once, then run disk-free jobs in this JS thread.
 * Guest execution is synchronous; browsers should use createWorkerCompiler.
 */
export async function createCompiler(modules: Modules): Promise<Compiler> {
  const compiler = await compileModule(modules.compiler);
  const generators = new Map<Language, WebAssembly.Module>();
  for (const [language, module] of Object.entries(modules.generators)) {
    if (!languages.includes(language as Language)) {
      throw new TypeError(`unknown generator: ${language}`);
    }
    if (module !== undefined) {
      generators.set(language as Language, await compileModule(module));
    }
  }

  return {
    async compile(input: CompileRequest): Promise<CompileResult> {
      // Snapshot and validate the whole job before yielding to guest execution.
      const files = snapshot(input.files, "src");
      const includes = snapshot(input.includeFiles ?? {}, "include");
      const entrypoints = [...input.entrypoints];
      const targets = [...input.generators];
      if (entrypoints.length === 0) {
        throw new TypeError("at least one entrypoint is required");
      }
      for (const path of entrypoints) {
        checkPath(path);
        if (!Object.hasOwn(files, `src/${path}`)) {
          throw new TypeError(`entrypoint is not in files: ${path}`);
        }
      }
      if (new Set(entrypoints).size !== entrypoints.length) {
        throw new TypeError("duplicate entrypoints");
      }
      if (new Set(targets).size !== targets.length) {
        throw new TypeError("duplicate generators");
      }
      for (const target of targets) {
        if (!generators.has(target)) {
          throw new TypeError(`generator was not supplied: ${target}`);
        }
      }
      const diagnostics: Diagnostic[] = [];
      async function execute(
        stage: "compiler" | Language,
        module: WebAssembly.Module,
        args: string[],
        stdin: Uint8Array,
        files: Record<string, Uint8Array>,
        readonly: boolean,
      ) {
        let result;
        try {
          result = await runCommand(module, args, stdin, files, readonly);
        } catch (cause) {
          if (cause instanceof CommandError && cause.stderr) {
            diagnostics.push({ stage, stderr: cause.stderr });
          }
          throw new CompileError(
            `${stage} trapped: ${
              cause instanceof Error ? cause.message : cause
            }`,
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
      );
      if (compiled.stdout.length === 0) {
        throw new CompileError(
          "compiler emitted no request",
          "compiler",
          diagnostics,
        );
      }
      const outputs: CompileResult["outputs"] = Object.create(null);
      for (const language of targets) {
        const generated = await execute(
          language,
          generators.get(language)!,
          [commands[language]],
          compiled.stdout,
          {},
          false,
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
      return { request: compiled.stdout, outputs, diagnostics };
    },
  };
}
