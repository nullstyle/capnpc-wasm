import type { Language, Modules } from "./types.ts";

const languages: readonly Language[] = ["cpp", "rust", "go", "zig"];

/**
 * Bound a WASI command's one defined, unshared wasm32 memory before the engine
 * can instantiate it. Only the memory section changes; instruction/data bytes
 * and all other sections remain intact. The engine validates the final module.
 * https://webassembly.github.io/spec/core/binary/modules.html#memory-section
 *
 * This part is synchronous and engine-free so both factories can reject
 * malformed module bytes on the calling thread with identical messages.
 */
export function boundMemory(
  module: unknown,
  maximum: number,
): Uint8Array<ArrayBuffer> {
  if (!(module instanceof Uint8Array)) {
    throw new TypeError(
      "Wasm module bytes are required to enforce memoryPages; opaque WebAssembly.Module objects cannot be inspected",
    );
  }
  const bytes = new Uint8Array(module);
  const header = [0, 97, 115, 109, 1, 0, 0, 0];
  if (header.some((value, index) => bytes[index] !== value)) {
    throw new TypeError("invalid Wasm header");
  }
  let position = 8;
  let memory: { start: number; end: number; replacement: number[] } | undefined;
  function u32(end: number): number {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      if (position >= end) throw new TypeError("truncated Wasm section");
      const byte = bytes[position++];
      if (i === 4 && byte > 15) {
        throw new TypeError("invalid Wasm u32 encoding");
      }
      value += (byte & 127) * 2 ** (7 * i);
      if (!(byte & 128)) return value;
    }
    throw new TypeError("invalid Wasm u32 encoding");
  }
  function leb(value: number): number[] {
    const output: number[] = [];
    do {
      const byte = value & 127;
      value = Math.floor(value / 128);
      output.push(byte | (value ? 128 : 0));
    } while (value);
    return output;
  }
  while (position < bytes.length) {
    const start = position;
    const id = bytes[position++];
    const size = u32(bytes.length);
    const end = position + size;
    if (end > bytes.length) throw new TypeError("truncated Wasm section");
    if (id === 5) {
      if (memory || u32(end) !== 1) {
        throw new TypeError("WASI command requires exactly one defined memory");
      }
      if (position >= end) throw new TypeError("truncated Wasm memory");
      const flags = bytes[position++];
      if (flags !== 0 && flags !== 1) {
        throw new TypeError("only unshared wasm32 memory is supported");
      }
      const initial = u32(end);
      const declaredMaximum = flags === 1 ? u32(end) : 65536;
      if (
        position !== end || initial > declaredMaximum || declaredMaximum > 65536
      ) throw new TypeError("invalid Wasm memory limits");
      if (initial > maximum) {
        throw new TypeError("initial guest memory exceeds memoryPages limit");
      }
      const payload = [
        1,
        1,
        ...leb(initial),
        ...leb(Math.min(maximum, declaredMaximum)),
      ];
      memory = {
        start,
        end,
        replacement: [5, ...leb(payload.length), ...payload],
      };
    }
    position = end;
  }
  if (!memory) {
    throw new TypeError("WASI command requires exactly one defined memory");
  }
  const rewritten = new Uint8Array(
    bytes.length - (memory.end - memory.start) + memory.replacement.length,
  );
  rewritten.set(bytes.subarray(0, memory.start));
  rewritten.set(memory.replacement, memory.start);
  rewritten.set(
    bytes.subarray(memory.end),
    memory.start + memory.replacement.length,
  );
  return rewritten;
}

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

/** Compile bounded bytes; engine rejections become TypeErrors with a cause. */
export async function compileBounded(
  module: Uint8Array,
  maximum: number,
): Promise<WebAssembly.Module> {
  const rewritten = boundMemory(module, maximum);
  let compiled: WebAssembly.Module;
  try {
    compiled = await WebAssembly.compile(rewritten);
  } catch (cause) {
    throw new TypeError(
      `the engine rejected the Wasm module: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
  for (const entry of WebAssembly.Module.imports(compiled)) {
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
  }
  return compiled;
}
