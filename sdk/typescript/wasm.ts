import { wasiImportNames } from "./runtime.ts";
import { interruptModule, interruptName } from "./interrupt.ts";
import { boundMemory, instrument } from "./rewriter.ts";
import type { Language, Modules } from "./types.ts";

export { boundMemory, instrument, type Instrumented } from "./rewriter.ts";

const languages: readonly Language[] = ["cpp", "rust", "go", "zig"];

/**
 * Validate the module set's shape and bytes without an engine. Both factories
 * run this first so bad inputs surface as identical TypeErrors on the calling
 * thread. Returns the generator languages that were supplied.
 */
export function inspectModules(modules: Modules, maximum: number): Language[] {
  if (typeof modules !== "object" || modules === null) {
    throw new TypeError(
      "modules must be an object with compiler bytes and a generators map",
    );
  }
  boundMemory(modules.compiler, maximum);
  if (typeof modules.generators !== "object" || modules.generators === null) {
    throw new TypeError(
      "modules.generators must map language names to module bytes",
    );
  }
  const supplied: Language[] = [];
  for (const [language, module] of Object.entries(modules.generators)) {
    if (!languages.includes(language as Language)) {
      throw new TypeError(`unknown generator: ${language}`);
    }
    if (module !== undefined) {
      boundMemory(module, maximum);
      supplied.push(language as Language);
    }
  }
  return supplied;
}

function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Validate, instrument and compile a private copy of the module bytes. An
 * invalid module is a TypeError with the engine's CompileError as `cause`. The
 * original is validated before the rewrite, which adds a type, a global and a
 * local at indices an invalid module could already name, and so must never
 * turn an invalid module into a valid one; an engine rejection of the
 * rewritten module is therefore an SDK bug, reported as a plain Error. The
 * result imports only WASI preview1 functions the pinned shim implements,
 * plus the interrupt import.
 */
export async function compileBounded(
  module: Uint8Array,
  maximum: number,
): Promise<WebAssembly.Module> {
  // What is validated is exactly what is rewritten, even if the caller's
  // buffer changes meanwhile.
  const original = new Uint8Array(module);
  if (!WebAssembly.validate(original)) {
    try {
      await WebAssembly.compile(original);
    } catch (cause) {
      throw new TypeError(
        `the engine rejected the Wasm module: ${reason(cause)}`,
        { cause },
      );
    }
    throw new TypeError("the engine rejected the Wasm module");
  }
  const { bytes } = instrument(original, maximum);
  let compiled: WebAssembly.Module;
  try {
    compiled = await WebAssembly.compile(bytes);
  } catch (cause) {
    throw new Error(
      `the interruption rewrite produced a module the engine rejected: ${
        reason(cause)
      }`,
      { cause },
    );
  }
  const imports = WebAssembly.Module.imports(compiled);
  // instrument() appends its import after every original one.
  const added = imports.pop();
  if (
    added?.module !== interruptModule || added.name !== interruptName ||
    added.kind !== "function"
  ) throw new Error("instrumentation did not add its interrupt import");
  for (const entry of imports) {
    if (entry.kind === "memory") {
      throw new TypeError("imported guest memory is not supported");
    }
    // Every WASI preview1 function is supplied; anything else would fail at
    // instantiation with an engine LinkError inside every job.
    if (
      entry.module !== "wasi_snapshot_preview1" || entry.kind !== "function"
    ) {
      throw new TypeError(
        `unsupported module import: ${entry.module}.${entry.name} (${entry.kind})`,
      );
    }
    if (!wasiImportNames.has(entry.name)) {
      throw new TypeError(
        `unsupported WASI import: wasi_snapshot_preview1.${entry.name}`,
      );
    }
  }
  const exports = WebAssembly.Module.exports(compiled);
  if (
    !exports.some((entry) =>
      entry.name === "memory" && entry.kind === "memory"
    ) ||
    !exports.some((entry) =>
      entry.name === "_start" && entry.kind === "function"
    )
  ) {
    throw new TypeError("WASI command must export memory and _start");
  }
  return compiled;
}
