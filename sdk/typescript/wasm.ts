/**
 * Bound a WASI command's one defined, unshared wasm32 memory before the engine
 * can instantiate it. Only the memory section changes; instruction/data bytes
 * and all other sections remain intact. The engine validates the final module.
 * https://webassembly.github.io/spec/core/binary/modules.html#memory-section
 */
export async function compileBounded(
  module: Uint8Array,
  maximum: number,
): Promise<WebAssembly.Module> {
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
  const compiled = await WebAssembly.compile(rewritten);
  if (
    WebAssembly.Module.imports(compiled).some((entry) =>
      entry.kind === "memory"
    )
  ) throw new TypeError("imported guest memory is not supported");
  return compiled;
}
