/**
 * Engine-free rewriting of WASI command modules: the memory bound and the
 * interruption checks (see interrupt.ts), applied in one pass. It imports no
 * shim and no engine API, so build and test tools can run it too.
 */
import {
  countdownExport,
  interruptModule,
  interruptName,
  pollInterval,
} from "./interrupt.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Bounds-checked reads over one section or body. */
class Reader {
  position: number;
  constructor(
    readonly bytes: Uint8Array,
    start: number,
    readonly end: number,
  ) {
    this.position = start;
  }
  byte(): number {
    if (this.position >= this.end) {
      throw new TypeError("truncated Wasm section");
    }
    return this.bytes[this.position++];
  }
  /** A u32 of at most five bytes with no bits beyond 32, as engines require. */
  u32(): number {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = this.byte();
      if (i === 4 && byte > 15) {
        throw new TypeError("invalid Wasm u32 encoding");
      }
      value += (byte & 127) * 2 ** (7 * i);
      if (!(byte & 128)) return value;
    }
    throw new TypeError("invalid Wasm u32 encoding");
  }
  /** A signed LEB128 i32 of at most five bytes, for `i32.const` values. */
  s32(): number {
    let value = 0;
    let shift = 0;
    let byte;
    do {
      if (shift >= 35) throw new TypeError("invalid Wasm integer encoding");
      byte = this.byte();
      value |= (byte & 127) << shift;
      shift += 7;
    } while (byte & 128);
    return shift < 32 && byte & 64 ? value | (-1 << shift) : value;
  }
  /**
   * Skip a LEB128 integer of at most `limit` bytes. Only immediates copied
   * verbatim are skipped this way; the engine validates their values.
   */
  leb(limit: number): void {
    for (let i = 0; i < limit; i++) if (!(this.byte() & 128)) return;
    throw new TypeError("invalid Wasm integer encoding");
  }
  skip(count: number): void {
    if (count > this.end - this.position) {
      throw new TypeError("truncated Wasm section");
    }
    this.position += count;
  }
  /** Read a name for comparison; output always copies the original bytes. */
  name(): string {
    const length = this.u32();
    const start = this.position;
    this.skip(length);
    return decoder.decode(this.bytes.subarray(start, this.position));
  }
}

/** Collects output as references to input ranges plus small encoded runs. */
class Writer {
  readonly parts: Uint8Array[] = [];
  #pending: number[] = [];
  length = 0;
  byte(value: number): void {
    this.#pending.push(value);
    this.length++;
  }
  bytes(data: Uint8Array): void {
    if (data.length === 0) return;
    this.#flush();
    this.parts.push(data);
    this.length += data.length;
  }
  u32(value: number): void {
    do {
      const low = value & 127;
      value = Math.floor(value / 128);
      this.byte(value ? low | 128 : low);
    } while (value);
  }
  s32(value: number): void {
    for (;;) {
      const low = value & 127;
      value >>= 7;
      if ((value === 0 && !(low & 64)) || (value === -1 && (low & 64))) {
        this.byte(low);
        return;
      }
      this.byte(low | 128);
    }
  }
  name(value: string): void {
    const bytes = encoder.encode(value);
    this.u32(bytes.length);
    this.bytes(bytes);
  }
  append(other: Writer): void {
    other.#flush();
    this.#flush();
    for (const part of other.parts) this.parts.push(part);
    this.length += other.length;
  }
  /** Reserve a place for output that is only known later; see fill(). */
  slot(): number {
    this.#flush();
    this.parts.push(new Uint8Array(0));
    return this.parts.length - 1;
  }
  fill(slot: number, content: Writer): void {
    const bytes = content.finish();
    this.length += bytes.length - this.parts[slot].length;
    this.parts[slot] = bytes;
  }
  finish(): Uint8Array<ArrayBuffer> {
    this.#flush();
    const output = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }
  #flush(): void {
    if (this.#pending.length) {
      this.parts.push(Uint8Array.from(this.#pending));
      this.#pending = [];
    }
  }
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

/** A private, header-checked copy of caller-supplied module bytes. */
function moduleBytes(module: unknown): Uint8Array<ArrayBuffer> {
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
  return bytes;
}

/**
 * The replacement payload for a memory section: exactly one unshared wasm32
 * memory, its maximum inserted or lowered to `maximum` pages.
 * https://webassembly.github.io/spec/core/binary/modules.html#memory-section
 */
function boundedMemory(section: Reader, maximum: number): number[] {
  if (section.u32() !== 1) {
    throw new TypeError("WASI command requires exactly one defined memory");
  }
  if (section.position >= section.end) {
    throw new TypeError("truncated Wasm memory");
  }
  const flags = section.byte();
  if (flags !== 0 && flags !== 1) {
    throw new TypeError("only unshared wasm32 memory is supported");
  }
  const initial = section.u32();
  const declaredMaximum = flags === 1 ? section.u32() : 65536;
  if (
    section.position !== section.end || initial > declaredMaximum ||
    declaredMaximum > 65536
  ) throw new TypeError("invalid Wasm memory limits");
  if (initial > maximum) {
    throw new TypeError("initial guest memory exceeds memoryPages limit");
  }
  return [1, 1, ...leb(initial), ...leb(Math.min(maximum, declaredMaximum))];
}

/**
 * Bound a WASI command's one defined, unshared wasm32 memory before the engine
 * can instantiate it, leaving every other byte intact. The engine validates
 * the final module.
 *
 * This check is synchronous and engine-free so both factories can reject
 * malformed module bytes on the calling thread with identical messages;
 * compileBounded applies the same memory rewrite inside `instrument`.
 */
export function boundMemory(
  module: unknown,
  maximum: number,
): Uint8Array<ArrayBuffer> {
  const bytes = moduleBytes(module);
  const reader = new Reader(bytes, 8, bytes.length);
  let memory: { start: number; end: number; replacement: number[] } | undefined;
  while (reader.position < bytes.length) {
    const start = reader.position;
    const id = reader.byte();
    const size = reader.u32();
    const end = reader.position + size;
    if (end > bytes.length) throw new TypeError("truncated Wasm section");
    if (id === 5) {
      if (memory) {
        throw new TypeError("WASI command requires exactly one defined memory");
      }
      const payload = boundedMemory(
        new Reader(bytes, reader.position, end),
        maximum,
      );
      memory = {
        start,
        end,
        replacement: [5, ...leb(payload.length), ...payload],
      };
    }
    reader.position = end;
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

/** Section ids in their required order; tags (13) sit between memory and globals. */
const sectionOrder: Readonly<Record<number, number>> = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  13: 6,
  6: 7,
  7: 8,
  8: 9,
  9: 10,
  12: 11,
  10: 12,
  11: 13,
};

/** Custom sections without code offsets or function indices, kept verbatim. */
const keptCustomSections = new Set(["producers", "target_features"]);

// Single-byte value types: numbers, v128, and the nullable reference
// shorthands (func, extern, exn, and the GC abstract types, which carry no
// immediates). 0x63 and 0x64 are followed by a heap type.
const valueTypes = new Set([
  0x7f,
  0x7e,
  0x7d,
  0x7c,
  0x7b,
  0x74,
  0x73,
  0x72,
  0x71,
  0x70,
  0x6f,
  0x6e,
  0x6d,
  0x6c,
  0x6b,
  0x6a,
  0x69,
]);

function hex(value: number): string {
  return `0x${value.toString(16).padStart(2, "0")}`;
}

/** A heap type is an s33: an abstract type code or a type index. */
function heapType(reader: Reader): void {
  reader.leb(5);
}

function valueType(reader: Reader): void {
  const code = reader.byte();
  if (code === 0x63 || code === 0x64) heapType(reader);
  else if (!valueTypes.has(code)) {
    throw new TypeError(`unsupported Wasm value type ${hex(code)}`);
  }
}

function blockType(reader: Reader): void {
  const code = reader.byte();
  if (code === 0x63 || code === 0x64) heapType(reader);
  // A continuation bit starts a multi-byte type index. Single bytes are the
  // empty type, a value type, or a small type index; none has immediates.
  else if (code & 128) reader.leb(4);
}

function memoryArgument(reader: Reader): void {
  const alignment = reader.u32();
  if (alignment & 64) reader.u32(); // multi-memory index
  reader.leb(10); // offset
}

/** A reference type with 32-bit limits; table64 is not supported. */
function tableType(reader: Reader): void {
  valueType(reader);
  const flags = reader.byte();
  if (flags > 1) throw new TypeError("unsupported Wasm table limits");
  reader.u32();
  if (flags === 1) reader.u32();
}

// SIMD sub-opcodes up to the last relaxed SIMD instruction (0x113) that no
// instruction uses, as the pinned wasm-tools decodes them.
const unassignedSimd = new Set([
  0x9a,
  0xa2,
  0xa5,
  0xa6,
  0xaf,
  0xb0,
  0xb2,
  0xb3,
  0xb4,
  0xbb,
  0xc2,
  0xc5,
  0xc6,
  0xcf,
  0xd0,
  0xd2,
  0xd3,
  0xd4,
  0xe2,
  0xee,
]);

// SIMD sub-opcodes with immediates. Every other assigned one up to 0x113 has
// none; unassigned and larger sub-opcodes are rejected.
function simdImmediates(reader: Reader, code: number): void {
  if (code <= 0x0b || code === 0x5c || code === 0x5d) memoryArgument(reader);
  else if (code === 0x0c || code === 0x0d) reader.skip(16);
  else if (code >= 0x15 && code <= 0x22) reader.skip(1);
  else if (code >= 0x54 && code <= 0x5b) {
    memoryArgument(reader);
    reader.skip(1);
  } else if (code > 0x113 || unassignedSimd.has(code)) {
    throw new TypeError(`unsupported Wasm instruction 0xfd ${code}`);
  }
}

// Bulk sub-opcodes of 0xfc whose cost grows with their size operand, which is
// an i32 on top of the stack: memory.init, memory.copy and memory.fill, and
// table.init, table.copy, table.grow and table.fill. Each is charged against
// the countdown by size, one tick per KiB or per 16 table entries, so a loop
// of large copies polls as often as one of plain instructions.
const memoryBulk = new Set([8, 10, 11]);
const tableBulk = new Set([12, 14, 15, 17]);
const memoryChargeShift = 10;
const tableChargeShift = 4;

/** The stack-neutral check: poll every `interval` ticks, trap on a nonzero answer. */
function checkSequence(
  counter: number,
  interrupt: number,
  interval: number,
): Uint8Array {
  const check = new Writer();
  check.byte(0x23); // global.get $countdown
  check.u32(counter);
  check.byte(0x45); // i32.eqz
  check.byte(0x04); // if
  check.byte(0x40);
  check.byte(0x10); //   call $interrupt
  check.u32(interrupt);
  check.byte(0x04); //   if
  check.byte(0x40);
  check.byte(0x00); //     unreachable
  check.byte(0x0b); //   end
  check.byte(0x41); //   i32.const interval
  check.s32(interval);
  check.byte(0x24); //   global.set $countdown
  check.u32(counter);
  check.byte(0x0b); // end
  check.byte(0x23); // global.get $countdown
  check.u32(counter);
  check.byte(0x41); // i32.const 1
  check.byte(0x01);
  check.byte(0x6b); // i32.sub
  check.byte(0x24); // global.set $countdown
  check.u32(counter);
  return check.finish();
}

/**
 * The charge before a bulk operation, stack-neutral around its i32 size
 * operand, which it keeps in the local `scratch`. A size of at least one tick
 * (`1 << shift`) polls first when its ticks reach the remaining countdown, and
 * is subtracted otherwise, so the countdown never goes below zero and the
 * plain check's `i32.eqz` still sees every expiry. A smaller size costs
 * nothing, like any straight-line instruction.
 */
function chargeSequence(
  counter: number,
  scratch: number,
  interrupt: number,
  interval: number,
  shift: number,
): Uint8Array {
  const charge = new Writer();
  const ticks = () => {
    charge.byte(0x20); // local.get $scratch
    charge.u32(scratch);
    charge.byte(0x41); // i32.const shift
    charge.s32(shift);
    charge.byte(0x76); // i32.shr_u
  };
  charge.byte(0x22); // local.tee $scratch: the size operand
  charge.u32(scratch);
  charge.byte(0x41); // i32.const 1 << shift
  charge.s32(1 << shift);
  charge.byte(0x4f); // i32.ge_u
  charge.byte(0x04); // if
  charge.byte(0x40);
  ticks();
  charge.byte(0x23); //   global.get $countdown
  charge.u32(counter);
  charge.byte(0x4f); //   i32.ge_u
  charge.byte(0x04); //   if
  charge.byte(0x40);
  charge.byte(0x10); //     call $interrupt
  charge.u32(interrupt);
  charge.byte(0x04); //     if
  charge.byte(0x40);
  charge.byte(0x00); //       unreachable
  charge.byte(0x0b); //     end
  charge.byte(0x41); //     i32.const interval
  charge.s32(interval);
  charge.byte(0x24); //     global.set $countdown
  charge.u32(counter);
  charge.byte(0x05); //   else
  charge.byte(0x23); //     global.get $countdown
  charge.u32(counter);
  ticks();
  charge.byte(0x6b); //     i32.sub
  charge.byte(0x24); //     global.set $countdown
  charge.u32(counter);
  charge.byte(0x0b); //   end
  charge.byte(0x0b); // end
  charge.byte(0x20); // local.get $scratch: the size operand again
  charge.u32(scratch);
  return charge.finish();
}

/** Parameters plus locals per function in every engine (V8, SpiderMonkey, JSC). */
const maxLocals = 50_000;

export interface Instrumented {
  /** The instrumented module, its memory bounded. */
  bytes: Uint8Array<ArrayBuffer>;
  /** Defined functions, and how many checks of each kind were inserted. */
  functions: number;
  entryChecks: number;
  loopChecks: number;
  importChecks: number;
  /** Bulk memory and table operations charged by size. */
  bulkChecks: number;
  /**
   * Imported functions that escape as references (element segments, `ref.func`,
   * exports), each now reached through an added function that calls it and
   * then checks.
   */
  thunks: number;
  /** The name section's fate: indices renumbered, dropped, or none present. */
  names: "renumbered" | "dropped" | "absent";
}

/**
 * Bound the memory and inject interruption checks (see interrupt.ts) in one
 * pass over a WASI command module.
 *
 * The module gains a `() -> i32` type, the import `capnp_wasm.interrupt`
 * (after every other import, so it takes the first defined-function index), a
 * mutable i32 countdown global (appended, shifting no global index) and that
 * global's export. Every defined function index shifts up by one: calls,
 * `ref.func`, exports, the start function, element segments, constant
 * expressions, and the name section's function and local names are
 * renumbered. A function with a charged bulk operation gains one i32 local
 * after its others, for the size. The name section is dropped whole when it
 * cannot be renumbered exactly: label names (the injected blocks shift label
 * indices), unknown subsections, or malformed contents. Other custom sections
 * except `producers` and `target_features` are dropped, because they may hold
 * code offsets or indices. All other instruction and data bytes are copied
 * verbatim.
 *
 * An imported function used as a value (in an element segment, a global's or
 * a segment's `ref.func`, or an export, which may declare one for code) gets a
 * thunk appended after the defined functions: it calls the import and then
 * checks, so a call through a table or reference, tail calls included, is
 * checked like a direct one. Values and table entries name the thunk; exports
 * and the start function keep the import, which only the host calls. One
 * added declarative element segment declares the thunks for `ref.func`.
 *
 * It fails closed: an opcode, type form, section or table initializer it
 * cannot parse exactly is a TypeError, never a guess. It does not validate:
 * compileBounded validates the original first, because an invalid original
 * could name the added type or globals by index.
 */
export function instrument(
  module: unknown,
  maximum: number,
  interval: number = pollInterval,
): Instrumented {
  if (
    !Number.isSafeInteger(interval) || interval < 1 || interval > 2 ** 31 - 1
  ) throw new RangeError("invalid interruption interval");
  const bytes = moduleBytes(module);
  const output = new Writer();
  output.bytes(bytes.subarray(0, 8));
  const result: Omit<Instrumented, "bytes"> = {
    functions: 0,
    entryChecks: 0,
    loopChecks: 0,
    importChecks: 0,
    bulkChecks: 0,
    thunks: 0,
    names: "absent",
  };

  let lastOrder = 0;
  let typeCount = 0;
  const paramCounts: number[] = [];
  let importedFunctions = 0;
  const importTypes: number[] = [];
  let importedGlobals = 0;
  let definedGlobals = 0;
  let definedFunctions = 0;
  const functionTypes: number[] = [];
  let exitFunction = -1;
  let memorySeen = false;
  let codeSeen = false;
  const pending = { type: true, import: true, global: true, export: true };
  // The function section waits in `slot` until the thunks are known.
  let functions: { entries: number; end: number; slot: number } | undefined;
  const thunkOf = new Map<number, number>();
  const thunkImports: number[] = [];
  let elementsSeen = false;
  let sealed = false;

  const shift = (index: number) =>
    index >= importedFunctions ? index + 1 : index;
  const countdown = () => importedGlobals + definedGlobals;

  /**
   * A function index used as a value. Imports escape through their thunks
   * once guest code exists to call them; every thunk is assigned before the
   * code section, since only elements, globals and exports declare a
   * `ref.func` target.
   */
  function reference(index: number): number {
    if (index >= importedFunctions) return index + 1;
    if (definedFunctions === 0) return index;
    let thunk = thunkOf.get(index);
    if (thunk === undefined) {
      if (sealed) throw new TypeError("undeclared Wasm function reference");
      thunk = importedFunctions + 1 + definedFunctions + thunkImports.length;
      thunkOf.set(index, thunk);
      thunkImports.push(index);
    }
    return thunk;
  }

  function framed(id: number, payload: Writer): Writer {
    const framedSection = new Writer();
    framedSection.byte(id);
    framedSection.u32(payload.length);
    framedSection.append(payload);
    return framedSection;
  }
  function emit(id: number, payload: Writer): void {
    output.append(framed(id, payload));
  }
  function verbatim(start: number, end: number): Writer {
    const payload = new Writer();
    payload.bytes(bytes.subarray(start, end));
    return payload;
  }
  function done(reader: Reader, what: string): void {
    if (reader.position !== reader.end) {
      throw new TypeError(`invalid Wasm ${what} section`);
    }
  }

  function interruptType(payload: Writer): void {
    payload.byte(0x60);
    payload.byte(0);
    payload.byte(1);
    payload.byte(0x7f);
  }
  function interruptImport(payload: Writer): void {
    payload.name(interruptModule);
    payload.name(interruptName);
    payload.byte(0);
    payload.u32(typeCount);
  }
  function countdownGlobal(payload: Writer): void {
    payload.byte(0x7f);
    payload.byte(1);
    payload.byte(0x41);
    payload.s32(interval);
    payload.byte(0x0b);
  }
  /** A declarative segment of every thunk: valid `ref.func` targets in code. */
  function declareThunks(payload: Writer): void {
    payload.u32(3);
    payload.byte(0); // funcref
    payload.u32(thunkImports.length);
    for (const index of thunkImports) payload.u32(thunkOf.get(index)!);
  }
  /**
   * Fix the thunk set: write the function section with one entry per thunk,
   * and declare the thunks in an element section of their own when the
   * module has none.
   */
  function seal(): void {
    if (sealed) return;
    sealed = true;
    result.thunks = thunkImports.length;
    if (!elementsSeen && thunkImports.length) {
      elementsSeen = true;
      const payload = new Writer();
      payload.u32(1);
      declareThunks(payload);
      emit(9, payload);
    }
    if (functions) {
      const payload = new Writer();
      payload.u32(definedFunctions + thunkImports.length);
      payload.bytes(bytes.subarray(functions.entries, functions.end));
      for (const index of thunkImports) payload.u32(importTypes[index]);
      output.fill(functions.slot, framed(3, payload));
    }
  }
  function countdownEntry(payload: Writer): void {
    payload.name(countdownExport);
    payload.byte(3);
    payload.u32(countdown());
  }

  /** Emit the added entries' sections that belong before `order` and were absent. */
  function synthesizeBefore(order: number): void {
    const single = (id: number, entry: (payload: Writer) => void) => {
      const payload = new Writer();
      payload.u32(1);
      entry(payload);
      emit(id, payload);
    };
    if (pending.type && order > 1) {
      pending.type = false;
      single(1, interruptType);
    }
    if (pending.import && order > 2) {
      pending.import = false;
      single(2, interruptImport);
    }
    if (pending.global && order > 7) {
      pending.global = false;
      single(6, countdownGlobal);
    }
    if (pending.export && order > 8) {
      pending.export = false;
      single(7, countdownEntry);
    }
    // Data count, code and data follow the element section.
    if (order > 10) seal();
  }

  /** Copy a constant expression, renumbering `ref.func`. */
  function constant(reader: Reader, payload: Writer): void {
    for (;;) {
      const start = reader.position;
      const op = reader.byte();
      switch (op) {
        case 0x0b:
          payload.byte(op);
          return;
        case 0xd2:
          payload.byte(op);
          payload.u32(reference(reader.u32()));
          continue;
        case 0x41:
          reader.leb(5);
          break;
        case 0x42:
          reader.leb(10);
          break;
        case 0x43:
          reader.skip(4);
          break;
        case 0x44:
          reader.skip(8);
          break;
        case 0x23:
          reader.u32();
          break;
        case 0xd0:
          heapType(reader);
          break;
        case 0x6a: // extended constants: i32 and i64 add, sub, mul
        case 0x6b:
        case 0x6c:
        case 0x7c:
        case 0x7d:
        case 0x7e:
          break;
        case 0xfd:
          if (reader.u32() !== 0x0c) {
            throw new TypeError("unsupported Wasm constant instruction 0xfd");
          }
          reader.skip(16);
          break;
        default:
          throw new TypeError(
            `unsupported Wasm constant instruction ${hex(op)}`,
          );
      }
      payload.bytes(bytes.subarray(start, reader.position));
    }
  }

  function types(reader: Reader): void {
    const count = reader.u32();
    const entries = reader.position;
    for (let i = 0; i < count; i++) {
      if (reader.byte() !== 0x60) {
        throw new TypeError(
          "unsupported Wasm type: only function types are supported (no GC types or recursion groups)",
        );
      }
      for (let side = 0; side < 2; side++) {
        const length = reader.u32();
        if (side === 0) paramCounts.push(length);
        for (let j = 0; j < length; j++) valueType(reader);
      }
    }
    done(reader, "type");
    typeCount = count;
    const payload = new Writer();
    payload.u32(count + 1);
    payload.bytes(bytes.subarray(entries, reader.end));
    interruptType(payload);
    pending.type = false;
    emit(1, payload);
  }

  function imports(reader: Reader): void {
    const count = reader.u32();
    const entries = reader.position;
    for (let i = 0; i < count; i++) {
      const moduleName = reader.name();
      const fieldName = reader.name();
      const kind = reader.byte();
      switch (kind) {
        case 0: {
          const type = reader.u32();
          // An index past the original types would name the added one.
          if (type >= typeCount) throw new TypeError("invalid Wasm type index");
          importTypes.push(type);
          if (
            moduleName === "wasi_snapshot_preview1" &&
            fieldName === "proc_exit"
          ) exitFunction = importedFunctions;
          importedFunctions++;
          break;
        }
        case 1:
          tableType(reader);
          break;
        case 2: {
          // compileBounded rejects every imported memory with a dedicated
          // message. Shared memories (whose waits block without polling) and
          // 64-bit ones (whose bulk sizes are i64) cannot be instrumented.
          const flags = reader.byte();
          if (flags > 15 || flags & 6) {
            throw new TypeError("unsupported Wasm memory import");
          }
          reader.leb(10);
          if (flags & 1) reader.leb(10);
          if (flags & 8) reader.u32();
          break;
        }
        case 3:
          valueType(reader);
          if (reader.byte() > 1) {
            throw new TypeError("unsupported Wasm global mutability");
          }
          importedGlobals++;
          break;
        case 4:
          if (reader.byte() !== 0) throw new TypeError("unsupported Wasm tag");
          reader.u32();
          break;
        default:
          throw new TypeError(`unsupported Wasm import kind ${kind}`);
      }
    }
    done(reader, "import");
    const payload = new Writer();
    payload.u32(count + 1);
    payload.bytes(bytes.subarray(entries, reader.end));
    interruptImport(payload);
    pending.import = false;
    emit(2, payload);
  }

  function tables(reader: Reader): void {
    const start = reader.position;
    const count = reader.u32();
    for (let i = 0; i < count; i++) {
      if (reader.bytes[reader.position] === 0x40) {
        throw new TypeError("unsupported Wasm table initializer");
      }
      tableType(reader);
    }
    done(reader, "table");
    emit(4, verbatim(start, reader.end));
  }

  function globals(reader: Reader): void {
    const count = reader.u32();
    const payload = new Writer();
    payload.u32(count + 1);
    for (let i = 0; i < count; i++) {
      const start = reader.position;
      valueType(reader);
      if (reader.byte() > 1) {
        throw new TypeError("unsupported Wasm global mutability");
      }
      payload.bytes(bytes.subarray(start, reader.position));
      constant(reader, payload);
    }
    done(reader, "global");
    definedGlobals = count;
    countdownGlobal(payload);
    pending.global = false;
    emit(6, payload);
  }

  function exports(reader: Reader): void {
    const count = reader.u32();
    const payload = new Writer();
    payload.u32(count + 1);
    for (let i = 0; i < count; i++) {
      const start = reader.position;
      if (reader.name() === countdownExport) {
        throw new TypeError(`the export name ${countdownExport} is reserved`);
      }
      payload.bytes(bytes.subarray(start, reader.position));
      const kind = reader.byte();
      if (kind > 4) throw new TypeError(`unsupported Wasm export kind ${kind}`);
      const index = reader.u32();
      // An exported import stays the host's function, but the export also
      // lets code take it with `ref.func`, which must then reach its thunk.
      if (kind === 0) reference(index);
      payload.byte(kind);
      payload.u32(kind === 0 ? shift(index) : index);
    }
    done(reader, "export");
    countdownEntry(payload);
    pending.export = false;
    emit(7, payload);
  }

  function elements(reader: Reader): void {
    const count = reader.u32();
    const segments = new Writer();
    for (let i = 0; i < count; i++) {
      const flags = reader.u32();
      if (flags > 7) throw new TypeError("unsupported Wasm element segment");
      segments.u32(flags);
      if (!(flags & 1)) {
        if (flags & 2) segments.u32(reader.u32()); // table index
        constant(reader, segments); // offset
      }
      if (flags & 4) {
        if (flags & 3) {
          const start = reader.position;
          valueType(reader);
          segments.bytes(bytes.subarray(start, reader.position));
        }
        const length = reader.u32();
        segments.u32(length);
        for (let j = 0; j < length; j++) constant(reader, segments);
      } else {
        if (flags & 3) {
          if (reader.byte() !== 0) {
            throw new TypeError("unsupported Wasm element kind");
          }
          segments.byte(0);
        }
        const length = reader.u32();
        segments.u32(length);
        for (let j = 0; j < length; j++) {
          segments.u32(reference(reader.u32()));
        }
      }
    }
    done(reader, "element");
    elementsSeen = true;
    const payload = new Writer();
    payload.u32(count + (thunkImports.length ? 1 : 0));
    payload.append(segments);
    if (thunkImports.length) declareThunks(payload);
    emit(9, payload);
    seal();
  }

  /**
   * Checks go after each `loop`, after each direct import call (an
   * `unreachable` after proc_exit instead), and at entry when the function
   * can call guest code: a defined function directly, or anything
   * indirectly. A leaf function runs a bounded number of instructions between
   * checks, so only loops and recursion need them. Bulk operations are
   * charged by size before they run.
   */
  function functionBody(
    reader: Reader,
    type: number,
    check: Uint8Array,
  ): Writer {
    const groups = reader.u32();
    const groupsStart = reader.position;
    let declared = 0;
    for (let i = 0; i < groups; i++) {
      declared += reader.u32();
      valueType(reader);
    }
    const groupsEnd = reader.position;
    // Charges keep bulk sizes in one added local, after every other one.
    const scratch = paramCounts[type] + declared;
    const charges = new Map<number, Uint8Array>();
    const charge = (shift: number) => {
      let sequence = charges.get(shift);
      if (!sequence) {
        sequence = chargeSequence(
          countdown(),
          scratch,
          importedFunctions,
          interval,
          shift,
        );
        charges.set(shift, sequence);
      }
      return sequence;
    };
    const instructions = new Writer();
    let from = reader.position;
    let callsGuest = false;
    // The value of an `i32.const` immediately before this instruction.
    let constant: number | undefined;
    const copyUntil = (position: number) => {
      if (position > from) {
        instructions.bytes(bytes.subarray(from, position));
      }
    };
    while (reader.position < reader.end) {
      const at = reader.position;
      const op = reader.bytes[reader.position++];
      const operand = constant;
      constant = undefined;
      switch (op) {
        case 0x03: // loop
          blockType(reader);
          copyUntil(reader.position);
          from = reader.position;
          instructions.bytes(check);
          result.loopChecks++;
          break;
        case 0x10: // call
        case 0x12: { // return_call
          const callee = reader.u32();
          copyUntil(at);
          from = reader.position;
          if (callee >= importedFunctions) {
            callsGuest = true;
            instructions.byte(op);
            instructions.u32(shift(callee));
            break;
          }
          instructions.byte(0x10);
          instructions.u32(callee);
          if (callee === exitFunction) instructions.byte(0x00);
          else {
            instructions.bytes(check);
            result.importChecks++;
            if (op === 0x12) instructions.byte(0x0f); // return
          }
          break;
        }
        case 0xd2: { // ref.func
          const index = reader.u32();
          copyUntil(at);
          from = reader.position;
          instructions.byte(op);
          instructions.u32(reference(index));
          break;
        }
        case 0x11: // call_indirect
        case 0x13: // return_call_indirect
          reader.u32();
          reader.u32();
          callsGuest = true;
          break;
        case 0x14: // call_ref
        case 0x15: // return_call_ref
          reader.u32();
          callsGuest = true;
          break;
        case 0x00: // unreachable
        case 0x01: // nop
        case 0x05: // else
        case 0x0a: // throw_ref
        case 0x0b: // end
        case 0x0f: // return
        case 0x19: // catch_all (legacy exceptions)
        case 0x1a: // drop
        case 0x1b: // select
        case 0xd1: // ref.is_null
        case 0xd3: // ref.eq
        case 0xd4: // ref.as_non_null
          break;
        case 0x02: // block
        case 0x04: // if
        case 0x06: // try (legacy exceptions)
          blockType(reader);
          break;
        case 0x07: // catch (legacy exceptions)
        case 0x08: // throw
        case 0x09: // rethrow (legacy exceptions)
        case 0x0c: // br
        case 0x0d: // br_if
        case 0x18: // delegate (legacy exceptions)
        case 0x20: // local.get
        case 0x21: // local.set
        case 0x22: // local.tee
        case 0x23: // global.get
        case 0x24: // global.set
        case 0x25: // table.get
        case 0x26: // table.set
        case 0x3f: // memory.size
        case 0x40: // memory.grow
        case 0xd5: // br_on_null
        case 0xd6: // br_on_non_null
          reader.u32();
          break;
        case 0x0e: { // br_table
          const length = reader.u32();
          for (let i = 0; i <= length; i++) reader.u32();
          break;
        }
        case 0x1c: { // select with types
          const length = reader.u32();
          for (let i = 0; i < length; i++) valueType(reader);
          break;
        }
        case 0x1f: { // try_table
          blockType(reader);
          const length = reader.u32();
          for (let i = 0; i < length; i++) {
            const kind = reader.byte();
            if (kind > 3) throw new TypeError("unsupported Wasm catch clause");
            if (kind < 2) reader.u32(); // tag
            reader.u32(); // label
          }
          break;
        }
        case 0x41: // i32.const
          constant = reader.s32();
          break;
        case 0x42: // i64.const
          reader.leb(10);
          break;
        case 0x43: // f32.const
          reader.skip(4);
          break;
        case 0x44: // f64.const
          reader.skip(8);
          break;
        case 0xd0: // ref.null
          heapType(reader);
          break;
        case 0xfc: {
          const code = reader.u32();
          if (code <= 7) break; // saturating truncation
          if (code === 8 || code === 10 || code === 12 || code === 14) {
            reader.u32();
            reader.u32();
          } else if (code <= 17) reader.u32();
          else {
            throw new TypeError(`unsupported Wasm instruction 0xfc ${code}`);
          }
          const unit = memoryBulk.has(code)
            ? memoryChargeShift
            : tableBulk.has(code)
            ? tableChargeShift
            : undefined;
          // A constant size below one tick costs no more than any other
          // instruction; no label can separate it from the operation.
          const small = operand !== undefined && operand >= 0 &&
            operand >> unit! === 0;
          if (unit !== undefined && !small) {
            // The operation itself is copied with the bytes that follow.
            copyUntil(at);
            from = at;
            instructions.bytes(charge(unit));
            result.bulkChecks++;
          }
          break;
        }
        case 0xfd:
          simdImmediates(reader, reader.u32());
          break;
        case 0xfe: { // atomics
          const code = reader.u32();
          if (code === 3) reader.skip(1); // atomic.fence
          else if (code <= 2 || (code >= 0x10 && code <= 0x4e)) {
            memoryArgument(reader);
          } else {
            throw new TypeError(`unsupported Wasm instruction 0xfe ${code}`);
          }
          break;
        }
        default:
          if (op >= 0x28 && op <= 0x3e) memoryArgument(reader);
          else if (op < 0x45 || op > 0xc4) {
            throw new TypeError(`unsupported Wasm instruction ${hex(op)}`);
          }
      }
    }
    copyUntil(reader.end);
    const head = new Writer();
    if (charges.size) {
      if (scratch + 1 > maxLocals) {
        throw new TypeError(
          "unsupported Wasm function: no local is left for bulk operation sizes",
        );
      }
      head.u32(groups + 1);
      head.bytes(bytes.subarray(groupsStart, groupsEnd));
      head.u32(1);
      head.byte(0x7f);
    } else {
      head.u32(groups);
      head.bytes(bytes.subarray(groupsStart, groupsEnd));
    }
    if (callsGuest) {
      head.bytes(check);
      result.entryChecks++;
    }
    head.append(instructions);
    return head;
  }

  function code(reader: Reader): void {
    const check = checkSequence(countdown(), importedFunctions, interval);
    const count = reader.u32();
    if (count !== definedFunctions) {
      throw new TypeError("invalid Wasm code section");
    }
    codeSeen = true;
    const payload = new Writer();
    payload.u32(count + thunkImports.length);
    for (let i = 0; i < count; i++) {
      const size = reader.u32();
      const start = reader.position;
      reader.skip(size);
      const body = functionBody(
        new Reader(bytes, start, start + size),
        functionTypes[i],
        check,
      );
      payload.u32(body.length);
      payload.append(body);
    }
    done(reader, "code");
    // Each thunk forwards its parameters to the import and checks after it.
    for (const index of thunkImports) {
      const body = new Writer();
      body.byte(0); // no locals
      for (let i = 0; i < paramCounts[importTypes[index]]; i++) {
        body.byte(0x20); // local.get
        body.u32(i);
      }
      body.byte(0x10); // call
      body.u32(index);
      if (index === exitFunction) body.byte(0x00); // unreachable
      else body.bytes(check);
      body.byte(0x0b);
      payload.u32(body.length);
      payload.append(body);
    }
    result.functions += count;
    emit(10, payload);
  }

  /**
   * Renumber the name section's function indices, or return undefined to drop
   * it. The function index space is final only after the import section.
   */
  function names(reader: Reader): Writer | undefined {
    if (lastOrder < 2) return undefined;
    try {
      const payload = new Writer();
      payload.name("name");
      while (reader.position < reader.end) {
        const id = reader.byte();
        const size = reader.u32();
        const end = reader.position + size;
        if (end > reader.end) return undefined;
        const part = new Reader(bytes, reader.position, end);
        reader.position = end;
        const rewritten = new Writer();
        switch (id) {
          case 1: { // function names
            const count = part.u32();
            rewritten.u32(count);
            for (let i = 0; i < count; i++) {
              rewritten.u32(shift(part.u32()));
              const start = part.position;
              part.name();
              rewritten.bytes(bytes.subarray(start, part.position));
            }
            break;
          }
          case 2: { // local names: an added scratch local and thunks are unnamed
            const count = part.u32();
            rewritten.u32(count);
            for (let i = 0; i < count; i++) {
              rewritten.u32(shift(part.u32()));
              const start = part.position;
              const locals = part.u32();
              for (let j = 0; j < locals; j++) {
                part.u32();
                part.name();
              }
              rewritten.bytes(bytes.subarray(start, part.position));
            }
            break;
          }
          case 0: // module
          case 4: // types: one is appended
          case 5: // tables
          case 6: // memories
          case 7: // globals: one is appended
          case 8: // element segments
          case 9: // data segments
          case 11: // tags
            rewritten.bytes(bytes.subarray(part.position, end));
            part.position = end;
            break;
          default: // label names, GC field names, unknown subsections
            return undefined;
        }
        if (part.position !== end) return undefined;
        payload.byte(id);
        payload.u32(rewritten.length);
        payload.append(rewritten);
      }
      return payload;
    } catch {
      return undefined;
    }
  }

  const reader = new Reader(bytes, 8, bytes.length);
  while (reader.position < bytes.length) {
    const id = reader.byte();
    const size = reader.u32();
    const start = reader.position;
    const end = start + size;
    if (end > bytes.length) throw new TypeError("truncated Wasm section");
    reader.position = end;
    const section = new Reader(bytes, start, end);
    if (id === 0) {
      const name = section.name();
      if (name === "name") {
        const renamed = names(section);
        result.names = renamed ? "renumbered" : "dropped";
        if (renamed) emit(0, renamed);
      } else if (keptCustomSections.has(name)) {
        emit(0, verbatim(start, end));
      }
      continue;
    }
    const order = sectionOrder[id];
    if (order === undefined) {
      throw new TypeError(`unsupported Wasm section ${id}`);
    }
    if (order <= lastOrder) throw new TypeError("invalid Wasm section order");
    lastOrder = order;
    synthesizeBefore(order);
    switch (id) {
      case 1:
        types(section);
        break;
      case 2:
        imports(section);
        break;
      case 3: {
        const count = section.u32();
        const entries = section.position;
        for (let i = 0; i < count; i++) {
          const type = section.u32();
          if (type >= typeCount) throw new TypeError("invalid Wasm type index");
          functionTypes.push(type);
        }
        done(section, "function");
        definedFunctions = count;
        functions = { entries, end, slot: output.slot() };
        break;
      }
      case 4:
        tables(section);
        break;
      case 5: {
        memorySeen = true;
        const payload = new Writer();
        for (const byte of boundedMemory(section, maximum)) payload.byte(byte);
        emit(5, payload);
        break;
      }
      case 6:
        globals(section);
        break;
      case 7:
        exports(section);
        break;
      case 8: {
        const payload = new Writer();
        payload.u32(shift(section.u32()));
        done(section, "start");
        emit(8, payload);
        break;
      }
      case 9:
        elements(section);
        break;
      case 10:
        code(section);
        break;
      default: // tag, data count and data: no function indices
        emit(id, verbatim(start, end));
    }
  }
  synthesizeBefore(Infinity);
  if (!memorySeen) {
    throw new TypeError("WASI command requires exactly one defined memory");
  }
  if (definedFunctions > 0 && !codeSeen) {
    throw new TypeError("invalid Wasm code section");
  }
  return { bytes: output.finish(), ...result };
}
