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

// SIMD sub-opcodes with immediates. Every other one up to the last relaxed
// SIMD instruction (0x113) has none; larger sub-opcodes are rejected.
function simdImmediates(reader: Reader, code: number): void {
  if (code <= 0x0b || code === 0x5c || code === 0x5d) memoryArgument(reader);
  else if (code === 0x0c || code === 0x0d) reader.skip(16);
  else if (code >= 0x15 && code <= 0x22) reader.skip(1);
  else if (code >= 0x54 && code <= 0x5b) {
    memoryArgument(reader);
    reader.skip(1);
  } else if (code > 0x113) {
    throw new TypeError(`unsupported Wasm instruction 0xfd ${code}`);
  }
}

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

export interface Instrumented {
  /** The instrumented module, its memory bounded. */
  bytes: Uint8Array<ArrayBuffer>;
  /** Defined functions, and how many checks of each kind were inserted. */
  functions: number;
  entryChecks: number;
  loopChecks: number;
  importChecks: number;
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
 * renumbered. The name section is dropped whole when it cannot be renumbered
 * exactly: label names (the injected blocks shift label indices), unknown
 * subsections, or malformed contents. Other custom sections except `producers`
 * and `target_features` are dropped, because they may hold code offsets or
 * indices. All other instruction and data bytes are copied verbatim.
 *
 * It fails closed: an opcode, type form, section or table initializer it
 * cannot parse exactly is a TypeError, never a guess.
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
    names: "absent",
  };

  let lastOrder = 0;
  let typeCount = 0;
  let importedFunctions = 0;
  let importedGlobals = 0;
  let definedGlobals = 0;
  let exitFunction = -1;
  let memorySeen = false;
  const pending = { type: true, import: true, global: true, export: true };

  const shift = (index: number) =>
    index >= importedFunctions ? index + 1 : index;
  const countdown = () => importedGlobals + definedGlobals;

  function emit(id: number, payload: Writer): void {
    output.byte(id);
    output.u32(payload.length);
    output.append(payload);
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
          payload.u32(shift(reader.u32()));
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
        case 0:
          reader.u32();
          if (
            moduleName === "wasi_snapshot_preview1" &&
            fieldName === "proc_exit"
          ) exitFunction = importedFunctions;
          importedFunctions++;
          break;
        case 1:
          tableType(reader);
          break;
        case 2: {
          // compileBounded rejects imported memories with a dedicated
          // message; any limits are parsed here.
          const flags = reader.byte();
          if (flags > 15) throw new TypeError("unsupported Wasm memory import");
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
    const payload = new Writer();
    payload.u32(count);
    for (let i = 0; i < count; i++) {
      const flags = reader.u32();
      if (flags > 7) throw new TypeError("unsupported Wasm element segment");
      payload.u32(flags);
      if (!(flags & 1)) {
        if (flags & 2) payload.u32(reader.u32()); // table index
        constant(reader, payload); // offset
      }
      if (flags & 4) {
        if (flags & 3) {
          const start = reader.position;
          valueType(reader);
          payload.bytes(bytes.subarray(start, reader.position));
        }
        const length = reader.u32();
        payload.u32(length);
        for (let j = 0; j < length; j++) constant(reader, payload);
      } else {
        if (flags & 3) {
          if (reader.byte() !== 0) {
            throw new TypeError("unsupported Wasm element kind");
          }
          payload.byte(0);
        }
        const length = reader.u32();
        payload.u32(length);
        for (let j = 0; j < length; j++) payload.u32(shift(reader.u32()));
      }
    }
    done(reader, "element");
    emit(9, payload);
  }

  /**
   * Checks go after each `loop`, after each direct import call (an
   * `unreachable` after proc_exit instead), and at entry when the function
   * can call guest code: a defined function directly, or anything
   * indirectly. A leaf function runs a bounded number of instructions between
   * checks, so only loops and recursion need them.
   */
  function functionBody(reader: Reader, check: Uint8Array): Writer {
    const head = new Writer();
    const localsStart = reader.position;
    const groups = reader.u32();
    for (let i = 0; i < groups; i++) {
      reader.u32();
      valueType(reader);
    }
    head.bytes(bytes.subarray(localsStart, reader.position));
    const instructions = new Writer();
    let from = reader.position;
    let callsGuest = false;
    const copyUntil = (position: number) => {
      if (position > from) {
        instructions.bytes(bytes.subarray(from, position));
      }
    };
    while (reader.position < reader.end) {
      const at = reader.position;
      const op = reader.bytes[reader.position++];
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
          instructions.u32(shift(index));
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
          reader.leb(5);
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
    const payload = new Writer();
    payload.u32(count);
    for (let i = 0; i < count; i++) {
      const size = reader.u32();
      const start = reader.position;
      reader.skip(size);
      const body = functionBody(new Reader(bytes, start, start + size), check);
      payload.u32(body.length);
      payload.append(body);
    }
    done(reader, "code");
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
          case 2: { // local names: instrumentation adds no locals
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
      default: // function, tag, data count and data: no function indices
        emit(id, verbatim(start, end));
    }
  }
  synthesizeBefore(Infinity);
  if (!memorySeen) {
    throw new TypeError("WASI command requires exactly one defined memory");
  }
  return { bytes: output.finish(), ...result };
}
