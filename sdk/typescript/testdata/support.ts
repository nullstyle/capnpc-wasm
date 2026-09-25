/** Helpers, fixtures and tiny guest modules shared by the SDK test files. */
import type { CompileRequest, CompileResult, Modules } from "../mod.ts";

export const root = new URL("../../../", import.meta.url);
export const workerURL = new URL("../worker.ts", import.meta.url);
export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export function assert(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

export function equalBytes(
  actual: Uint8Array,
  expected: Uint8Array,
  name: string,
): void {
  assert(actual.length === expected.length, `${name}: byte length differs`);
  assert(
    actual.every((byte, i) => byte === expected[i]),
    `${name}: bytes differ`,
  );
}

export function equalOutputs(
  actual: Pick<CompileResult, "outputs">,
  expected: Pick<CompileResult, "outputs">,
): void {
  assert(
    JSON.stringify(Object.keys(actual.outputs).sort()) ===
      JSON.stringify(Object.keys(expected.outputs).sort()),
    "output languages differ",
  );
  for (const language of ["cpp", "rust", "go", "zig"] as const) {
    const actualFiles = actual.outputs[language];
    const expectedFiles = expected.outputs[language];
    if (!actualFiles || !expectedFiles) continue;
    assert(
      JSON.stringify(Object.keys(actualFiles).sort()) ===
        JSON.stringify(Object.keys(expectedFiles).sort()),
      `${language}: output paths differ`,
    );
    for (const [path, bytes] of Object.entries(actualFiles)) {
      equalBytes(bytes, expectedFiles[path], `${language}/${path}`);
    }
  }
}

/** Reject with the given error name; optionally a message substring. */
export async function rejects(
  operation: () => Promise<unknown>,
  name: string,
  message?: string,
): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof Error, "rejection was not an Error");
    assert(error.name === name, `expected ${name}, received ${error}`);
    if (message) assert(error.message.includes(message), error.message);
    return error;
  }
  throw new Error(`expected ${name} rejection`);
}

/** Reject with an instance of the given class and exactly this message. */
export async function rejectsWith<T extends Error>(
  operation: () => Promise<unknown>,
  // deno-lint-ignore no-explicit-any
  constructor: new (...args: any[]) => T,
  message?: string,
): Promise<T> {
  try {
    await operation();
  } catch (error) {
    assert(
      error instanceof constructor,
      `expected ${constructor.name}, received ${
        error instanceof Error ? error.constructor.name : typeof error
      }: ${error}`,
    );
    if (message !== undefined) {
      assert(
        error.message === message,
        `expected message ${JSON.stringify(message)}, received ${
          JSON.stringify(error.message)
        }`,
      );
    }
    return error;
  }
  throw new Error(`expected ${constructor.name} rejection`);
}

/**
 * A worker-client test. Worker execution is admitted on every Deno release: guests
 * stop themselves, so no test depends on the host's Worker.terminate().
 */
export function workerTest(name: string, fn: Deno.TestDefinition["fn"]) {
  Deno.test({ name, fn });
}

export function wasm(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
}

export function sharedBytes(bytes: Uint8Array): Uint8Array {
  // Offset views also catch snapshots that copy the whole backing buffer.
  const view = new Uint8Array(
    new SharedArrayBuffer(bytes.length + 16),
    8,
    bytes.length,
  );
  view.set(bytes);
  return view;
}

// Tiny command modules make timeout and failure tests deterministic without a
// tool subprocess. Each exports one memory and _start. loopGuest executes
// `(loop (br 0))`; trapGuest executes `unreachable`.
export const loopGuest = wasm(
  "0061736d01000000010401600000030201000503010001071302066d656d6f72790200065f737461727400000a0901070003400c000b0b",
);
export const trapGuest = wasm(
  "0061736d01000000010401600000030201000503010001071302066d656d6f72790200065f737461727400000a05010300000b",
);
// Writes the single byte 'x' to stdout using WASI fd_write, then exits normally.
export const malformedRequestGuest = wasm(
  "0061736d01000000010c0260047f7f7f7f017f60000002230116776173695f736e617073686f745f70726576696577310866645f77726974650000030201010503010001071302066d656d6f72790200065f737461727400010a0f010d00410141004101410c10001a0b0b0f010041000b09080000000100000078",
);
// Writes 'x' to stderr before trapping, to exercise structured trap diagnostics.
export const stderrTrapGuest = wasm(
  "0061736d01000000010c0260047f7f7f7f017f60000002230116776173695f736e617073686f745f70726576696577310866645f77726974650000030201010503010001071302066d656d6f72790200065f737461727400010a10010e00410241004101410c10001a000b0b0f010041000b09080000000100000078",
);

export async function read(path: string): Promise<Uint8Array> {
  return await Deno.readFile(new URL(path, root));
}

let fixturePromise: Promise<{ modules: Modules; request: CompileRequest }>;
/** The real toolchain modules and the person/common workspace, loaded once. */
export function fixture() {
  return fixturePromise ??= (async () => {
    const [
      compiler,
      cpp,
      rust,
      go,
      zig,
      person,
      common,
      cxxAnnotations,
      goAnnotations,
    ] = await Promise.all([
      read("build/wasm/bin/capnp.wasm"),
      read("build/wasm/bin/capnpc-c++.wasm"),
      read("build/wasm/bin/capnpc-rust.wasm"),
      read("build/wasm/bin/capnpc-go.wasm"),
      read("build/wasm/bin/capnpc-zig.wasm"),
      read("tests/fixtures/schemas/person.capnp"),
      read("tests/fixtures/schemas/types/common.capnp"),
      read("ref/capnproto/c++/src/capnp/c++.capnp"),
      read("ref/go-capnp/std/go.capnp"),
    ]);
    return {
      modules: { compiler, generators: { cpp, rust, go, zig } },
      request: {
        files: { "person.capnp": person, "types/common.capnp": common },
        includeFiles: {
          "capnp/c++.capnp": cxxAnnotations,
          "go.capnp": goAnnotations,
        },
        entrypoints: ["person.capnp", "types/common.capnp"],
        generators: ["cpp", "rust", "go", "zig"],
      },
    };
  })();
}

export function simpleRequest(name = "Person"): CompileRequest {
  return {
    files: {
      "example.capnp":
        `@0xece4bf9c1f867623; struct ${name} { value @0 :Text; }`,
    },
    entrypoints: ["example.capnp"],
    generators: ["cpp"],
  };
}

export function leb(value: number): number[] {
  const bytes: number[] = [];
  do {
    const part = value & 127;
    value = Math.floor(value / 128);
    bytes.push(part | (value ? 128 : 0));
  } while (value);
  return bytes;
}
export function section(id: number, bytes: number[]): number[] {
  return [id, ...leb(bytes.length), ...bytes];
}
export function name(value: string): number[] {
  const bytes = [...encoder.encode(value)];
  return [...leb(bytes.length), ...bytes];
}
/** A command importing fd_write whose body is `code`; data lands at address 0. */
export function commandGuest(
  code: number[],
  data: number[] = [8, 0, 0, 0, 1, 0, 0, 0, 120],
  memory = [0, 1],
): Uint8Array {
  const body = [0, ...code, 0x0b];
  return new Uint8Array([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(1, [2, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 0]),
    ...section(2, [
      1,
      ...name("wasi_snapshot_preview1"),
      ...name("fd_write"),
      0,
      0,
    ]),
    ...section(3, [1, 1]),
    ...section(5, [1, ...memory]),
    ...section(7, [2, ...name("memory"), 2, 0, ...name("_start"), 0, 1]),
    ...section(10, [1, ...leb(body.length), ...body]),
    ...section(11, [1, 0, 0x41, 0, 0x0b, ...leb(data.length), ...data]),
  ]);
}
/** fd_write(1, iovec at 0, 1, nwritten at 12), i.e. one 'x' to stdout. */
export const writeX = [0x41, 1, 0x41, 0, 0x41, 1, 0x41, 12, 0x10, 0, 0x1a];
