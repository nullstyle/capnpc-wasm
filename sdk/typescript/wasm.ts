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

/**
 * Instrument and compile bounded bytes. Engine rejections become TypeErrors
 * with the engine error as `cause`. The result imports only WASI preview1
 * functions the pinned shim implements, plus the interrupt import.
 */
export async function compileBounded(
  module: Uint8Array,
  maximum: number,
): Promise<WebAssembly.Module> {
  const { bytes } = instrument(module, maximum);
  let compiled: WebAssembly.Module;
  try {
    compiled = await WebAssembly.compile(bytes);
  } catch (cause) {
    throw new TypeError(
      `the engine rejected the Wasm module: ${
        cause instanceof Error ? cause.message : String(cause)
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
