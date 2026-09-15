import {
  CompileError,
  type CompileRequest,
  type CompileResult,
  createCompiler,
  createWorkerCompiler,
  type Modules,
  supportedDenoWorkerVersion,
} from "./mod.ts";
import { runCommand } from "./runtime.ts";

const root = new URL("../../", import.meta.url);
const workerURL = new URL("./worker.ts", import.meta.url);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equalBytes(
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

function equalOutputs(
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

async function rejects(
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

function workerTest(name: string, fn: Deno.TestDefinition["fn"]) {
  Deno.test({
    name,
    fn,
    ignore: Deno.version.deno !== supportedDenoWorkerVersion,
  });
}

Deno.test("SDK rejects unverified Deno worker runtimes before executing guests", async () => {
  if (Deno.version.deno === supportedDenoWorkerVersion) return;
  await rejects(
    () =>
      createWorkerCompiler(workerURL, { compiler: loopGuest, generators: {} }),
    "Error",
    `use Deno ${supportedDenoWorkerVersion}`,
  );
});

function wasm(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
}

Deno.test("SDK confines compiler source prefixes and ordered import roots", async () => {
  const compiler = await createCompiler({
    compiler: trapGuest,
    generators: {},
  });
  const job = {
    files: { "example.capnp": "@0xece4bf9c1f867623; struct Example {}" },
    entrypoints: ["example.capnp"],
    generators: [] as [],
  };
  for (
    const path of ["../escape", "/absolute", "a/../b", "a\\b", "a\0b", "a//b"]
  ) {
    await rejects(
      () => compiler.compile({ ...job, sourcePrefix: path }),
      "TypeError",
    );
    await rejects(
      () => compiler.compile({ ...job, importPaths: [path] }),
      "TypeError",
    );
  }
  await rejects(
    () => compiler.compile({ ...job, importPaths: ["", ""] }),
    "TypeError",
    "duplicate",
  );
});

function sharedBytes(bytes: Uint8Array): Uint8Array {
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
const loopGuest = wasm(
  "0061736d01000000010401600000030201000503010001071302066d656d6f72790200065f737461727400000a0901070003400c000b0b",
);
const trapGuest = wasm(
  "0061736d01000000010401600000030201000503010001071302066d656d6f72790200065f737461727400000a05010300000b",
);
// Writes the single byte 'x' to stdout using WASI fd_write, then exits normally.
const malformedRequestGuest = wasm(
  "0061736d01000000010c0260047f7f7f7f017f60000002230116776173695f736e617073686f745f70726576696577310866645f77726974650000030201010503010001071302066d656d6f72790200065f737461727400010a0f010d00410141004101410c10001a0b0b0f010041000b09080000000100000078",
);
// Writes 'x' to stderr before trapping, to exercise structured trap diagnostics.
const stderrTrapGuest = wasm(
  "0061736d01000000010c0260047f7f7f7f017f60000002230116776173695f736e617073686f745f70726576696577310866645f77726974650000030201010503010001071302066d656d6f72790200065f737461727400010a10010e00410241004101410c10001a000b0b0f010041000b09080000000100000078",
);

async function read(path: string): Promise<Uint8Array> {
  return await Deno.readFile(new URL(path, root));
}

let fixturePromise: Promise<{ modules: Modules; request: CompileRequest }>;
function fixture() {
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

function simpleRequest(name = "Person"): CompileRequest {
  return {
    files: {
      "example.capnp":
        `@0xece4bf9c1f867623; struct ${name} { value @0 :Text; }`,
    },
    entrypoints: ["example.capnp"],
    generators: ["cpp"],
  };
}

Deno.test("SDK generates all languages from one workspace", async () => {
  const { modules, request } = await fixture();
  const compiler = await createCompiler(modules);
  const result = await compiler.compile(request);
  assert(result.request.length > 0, "missing binary request");
  assert(result.diagnostics.length === 0, "unexpected diagnostics");
  const expected = {
    cpp: [
      "person.capnp.c++",
      "person.capnp.h",
      "types/common.capnp.c++",
      "types/common.capnp.h",
    ],
    rust: ["person_capnp.rs", "types/common_capnp.rs"],
    go: ["person.capnp.go", "types/common.capnp.go"],
    zig: ["person.zig", "types/common.zig"],
  };
  for (const language of ["cpp", "rust", "go", "zig"] as const) {
    const files = result.outputs[language]!;
    assert(
      JSON.stringify(Object.keys(files).sort()) ===
        JSON.stringify(expected[language]),
      `${language}: unexpected output paths`,
    );
    for (const bytes of Object.values(files)) {
      assert(bytes.length > 0, "empty generated file");
      assert(
        bytes.buffer instanceof ArrayBuffer && !bytes.buffer.resizable,
        "resizable output buffer",
      );
    }
  }
  assert(
    decoder.decode(result.outputs.cpp!["person.capnp.h"]).includes(
      "struct Person",
    ),
    "missing C++ Person",
  );
  assert(
    decoder.decode(result.outputs.rust!["person_capnp.rs"]).includes(
      "pub mod person",
    ),
    "missing Rust person",
  );
  assert(
    decoder.decode(result.outputs.go!["person.capnp.go"]).includes(
      "type Person capnp.Struct",
    ),
    "missing Go Person",
  );
  equalOutputs(await compiler.compile(request), result);
  const requestOnly = await compiler.compile({ ...request, generators: [] });
  assert(
    requestOnly.request.length > 0,
    "request-only compile returned no bytes",
  );
  assert(
    Object.keys(requestOnly.outputs).length === 0,
    "request-only compile generated files",
  );
});

Deno.test("SDK snapshots inputs and isolates repeated and concurrent jobs", async () => {
  const { modules } = await fixture();
  const compiler = await createCompiler(modules);
  const path = "café-🦀.capnp";
  const original = encoder.encode(
    "@0xf9954e1a66268315; struct Unicode { value @0 :Text; }",
  );
  const input = new Uint8Array(original);
  const job: CompileRequest = {
    files: { [path]: input },
    entrypoints: [path],
    generators: ["cpp"],
  };
  const pending = compiler.compile(job);
  input.fill(0);
  const first = await pending;
  assert(
    first.outputs.cpp?.[`${path}.h`],
    "Unicode argv path was not preserved",
  );
  const pristine = await compiler.compile({
    ...job,
    files: { [path]: original },
  });
  equalOutputs(first, pristine);
  first.outputs.cpp![`${path}.h`].fill(0);
  equalOutputs(
    await compiler.compile({ ...job, files: { [path]: original } }),
    pristine,
  );

  const [one, two] = await Promise.all([
    compiler.compile(simpleRequest("First")),
    compiler.compile(simpleRequest("Second")),
  ]);
  const firstHeader = decoder.decode(one.outputs.cpp!["example.capnp.h"]);
  const secondHeader = decoder.decode(two.outputs.cpp!["example.capnp.h"]);
  assert(
    firstHeader.includes("struct First") &&
      !firstHeader.includes("struct Second"),
    "first job leaked files",
  );
  assert(
    secondHeader.includes("struct Second") &&
      !secondHeader.includes("struct First"),
    "second job leaked files",
  );
});

Deno.test("SDK rejects invalid workspaces before running a guest", async () => {
  const compiler = await createCompiler({
    compiler: trapGuest,
    generators: { cpp: trapGuest },
  });
  for (
    const path of [
      "",
      "/absolute",
      "../escape",
      "a/../b",
      "./a",
      "a//b",
      "a/",
      "a\\b",
      "a\0b",
      "a\ud800",
    ]
  ) {
    await rejects(
      () =>
        compiler.compile({
          files: { [path]: "x" },
          entrypoints: [path],
          generators: [],
        }),
      "TypeError",
      "canonical",
    );
  }
  await rejects(
    () =>
      compiler.compile({
        files: { a: "x", "a/b": "y" },
        entrypoints: ["a"],
        generators: [],
      }),
    "TypeError",
    "collision",
  );
  await rejects(
    () => compiler.compile({ ...simpleRequest(), entrypoints: [] }),
    "TypeError",
    "entrypoint",
  );
  await rejects(
    () =>
      compiler.compile({ ...simpleRequest(), entrypoints: ["missing.capnp"] }),
    "TypeError",
    "not in files",
  );
  await rejects(
    () =>
      compiler.compile({
        ...simpleRequest(),
        entrypoints: ["example.capnp", "example.capnp"],
      }),
    "TypeError",
    "duplicate entrypoints",
  );
  await rejects(
    () => compiler.compile({ ...simpleRequest(), generators: ["cpp", "cpp"] }),
    "TypeError",
    "duplicate generators",
  );
  await rejects(
    () => compiler.compile({ ...simpleRequest(), generators: ["go"] }),
    "TypeError",
    "not supplied",
  );
  await rejects(
    () =>
      compiler.compile({
        ...simpleRequest(),
        includeFiles: { "../escape": "x" },
      }),
    "TypeError",
    "canonical",
  );
});

Deno.test("SDK reports compiler, generator, and trap failures without outputs", async () => {
  const { modules } = await fixture();
  const compiler = await createCompiler(modules);
  const error = await rejects(
    () =>
      compiler.compile({
        files: {
          "broken.capnp": "@0xece4bf9c1f867623; struct Broken { invalid",
        },
        entrypoints: ["broken.capnp"],
        generators: ["cpp"],
      }),
    "CompileError",
  );
  assert(
    error instanceof CompileError && error.stage === "compiler",
    "wrong failure stage",
  );
  assert(
    error.exitCode !== 0 && error.exitCode !== undefined,
    "missing exit status",
  );
  assert(
    error.diagnostics.some((entry) => entry.stderr.includes("broken.capnp")),
    "missing source diagnostic",
  );
  assert(!("outputs" in error), "failure exposed partial output");
  const noisy = await createCompiler({
    ...modules,
    generators: { cpp: malformedRequestGuest },
  });
  await rejects(
    () => noisy.compile(simpleRequest()),
    "CompileError",
    "unexpectedly wrote to stdout",
  );
  for (const language of ["cpp", "rust", "go", "zig"] as const) {
    const malformed = await createCompiler({
      ...modules,
      compiler: malformedRequestGuest,
    });
    const generatedError = await rejects(
      () => malformed.compile({ ...simpleRequest(), generators: [language] }),
      "CompileError",
    );
    assert(
      generatedError instanceof CompileError &&
        generatedError.stage === language,
      "malformed request failure lost generator stage",
    );
    assert(
      generatedError.diagnostics.some((entry) =>
        entry.stage === language && entry.stderr.length > 0
      ),
      "missing generator diagnostic",
    );
    assert(!("outputs" in generatedError), "generator failure exposed output");
  }
  const trapped = await createCompiler({
    compiler: stderrTrapGuest,
    generators: {},
  });
  const trap = await rejects(
    () => trapped.compile({ ...simpleRequest(), generators: [] }),
    "CompileError",
    "trapped",
  );
  assert(
    trap instanceof CompileError && trap.stage === "compiler" && trap.cause,
    "trap lost cause",
  );
  assert(
    trap.diagnostics.some((entry) =>
      entry.stage === "compiler" && entry.stderr === "x"
    ),
    "trap lost structured stderr",
  );
  assert(
    (await compiler.compile(simpleRequest())).outputs.cpp,
    "failed job polluted later compilation",
  );
});

Deno.test("SDK compiler filesystem is read-only", async () => {
  const { modules, request } = await fixture();
  const compiler = await createCompiler(modules);
  const compiled = await compiler.compile({ ...request, generators: [] });
  const result = await runCommand(
    await WebAssembly.compile(
      new Uint8Array(modules.generators.cpp as Uint8Array),
    ),
    ["capnpc-c++"],
    compiled.request,
    { sentinel: encoder.encode("unchanged") },
    true,
  );
  assert(
    result.code !== 0 && result.stderr.length > 0,
    "read-only guest wrote generated files",
  );
  assert(
    Object.keys(result.files).length === 0,
    "read-only failure published files",
  );
});

Deno.test("SDK generates from saved requests without running the frontend", async () => {
  const { modules, request } = await fixture();
  const compiler = await createCompiler(modules);
  const expected = await compiler.compile(request);
  const generator = await createCompiler({ ...modules, compiler: trapGuest });
  const saved = expected.request.slice();
  const running = generator.generate({
    request: saved,
    generators: request.generators,
  });
  saved.fill(0);
  equalOutputs(await running, expected);
  const [rust, go] = await Promise.all([
    generator.generate({ request: expected.request, generators: ["rust"] }),
    generator.generate({ request: expected.request, generators: ["go"] }),
  ]);
  equalOutputs({ outputs: { ...rust.outputs, ...go.outputs } }, {
    outputs: { rust: expected.outputs.rust, go: expected.outputs.go },
  });
  rust.outputs.rust!["person_capnp.rs"].fill(0);
  equalOutputs(
    await generator.generate({
      request: expected.request,
      generators: request.generators,
    }),
    expected,
  );

  for (const generators of [[], ["cpp", "cpp"], ["python"]]) {
    await rejects(() =>
      generator.generate({
        request: expected.request,
        generators: generators as ("cpp")[],
      }), "TypeError");
  }
  for (
    const bytes of [new Uint8Array(), new Uint8Array(64 * 1024 * 1024 + 1)]
  ) {
    await rejects(
      () => generator.generate({ request: bytes, generators: ["cpp"] }),
      "TypeError",
    );
  }
  const malformed = await rejects(() =>
    generator.generate({
      request: expected.request.slice(0, 12),
      generators: ["cpp"],
    }), "CompileError");
  assert(
    malformed instanceof CompileError && malformed.stage === "cpp" &&
      malformed.diagnostics.length > 0,
    "generation lost failure details",
  );
  assert(!("outputs" in malformed), "generation published partial output");

  const noGoAnnotations = await compiler.compile({
    ...request,
    files: {
      ...request.files,
      "person.capnp": decoder.decode(
        request.files["person.capnp"] as Uint8Array,
      )
        .replace('$Go.package("fixture");', ""),
    },
    generators: [],
  });
  const laterFailure = await rejects(() =>
    generator.generate({
      request: noGoAnnotations.request,
      generators: ["cpp", "go"],
    }), "CompileError");
  assert(
    laterFailure instanceof CompileError && laterFailure.stage === "go" &&
      !("outputs" in laterFailure),
    "later failure exposed earlier generator outputs",
  );
});

workerTest(
  "SDK worker generates saved requests with hard cancellation and reuse",
  async () => {
    const { modules, request } = await fixture();
    const expected = await (await createCompiler(modules)).compile(request);
    const worker = await createWorkerCompiler(workerURL, {
      ...modules,
      compiler: trapGuest,
      generators: { ...modules.generators, cpp: loopGuest },
    });
    const job = {
      request: expected.request,
      generators: ["rust", "go"] as const,
    };
    try {
      equalOutputs(await worker.generate(job), {
        outputs: { rust: expected.outputs.rust, go: expected.outputs.go },
      });
      await rejects(() =>
        worker.generate({ ...job, generators: ["cpp"] }, {
          timeoutMs: 100,
        }), "TimeoutError");
      const controller = new AbortController();
      const running = worker.generate({ ...job, generators: ["cpp"] }, {
        signal: controller.signal,
      });
      const abortTimer = setTimeout(() => controller.abort(), 100);
      try {
        await rejects(() => running, "AbortError");
      } finally {
        clearTimeout(abortTimer);
      }
      equalOutputs(await worker.generate(job), {
        outputs: { rust: expected.outputs.rust, go: expected.outputs.go },
      });
      const failure = await rejects(() =>
        worker.generate({
          ...job,
          request: expected.request.slice(0, 12),
        }), "CompileError");
      assert(
        failure instanceof CompileError && failure.stage === "rust",
        "worker lost generator stage",
      );
    } finally {
      worker.dispose();
    }
  },
);

workerTest("SDK worker matches core output and preserves errors", async () => {
  const { modules, request } = await fixture();
  const core = await createCompiler(modules);
  const expected = await core.compile(request);
  const worker = await createWorkerCompiler(workerURL, modules);
  try {
    equalOutputs(await worker.compile(request), expected);
    const error = await rejects(
      () =>
        worker.compile({
          ...request,
          files: { ...request.files, "person.capnp": "invalid schema" },
        }),
      "CompileError",
    );
    assert(
      error instanceof CompileError && error.stage === "compiler" &&
        error.diagnostics.length > 0,
      "worker lost structured diagnostic",
    );
    equalOutputs(await worker.compile(request), expected);
    await rejects(
      () => worker.compile({ ...request, entrypoints: [] }),
      "TypeError",
      "entrypoint",
    );
    equalOutputs(await worker.compile(request), expected);
  } finally {
    worker.dispose();
  }
  await rejects(() => worker.compile(request), "Error", "disposed");
});

workerTest(
  "SDK worker snapshots shared request and workspace bytes",
  async (t) => {
    const { modules, request } = await fixture();
    const expected = await (await createCompiler(modules)).compile(request);
    const worker = await createWorkerCompiler(workerURL, modules);
    try {
      await t.step("standalone request", async () => {
        const bytes = sharedBytes(expected.request);
        const pending = worker.generate({
          request: bytes,
          generators: request.generators,
        });
        bytes.fill(0);
        equalOutputs(await pending, expected);
      });
      await t.step("schema and include files", async () => {
        const share = (files: CompileRequest["files"]) =>
          Object.fromEntries(
            Object.entries(files).map(([name, bytes]) => [
              name,
              sharedBytes(
                typeof bytes === "string" ? encoder.encode(bytes) : bytes,
              ),
            ]),
          );
        const files = share(request.files);
        const includeFiles = share(request.includeFiles!);
        const pending = worker.compile({ ...request, files, includeFiles });
        for (
          const bytes of [
            ...Object.values(files),
            ...Object.values(includeFiles),
          ]
        ) {
          bytes.fill(0);
        }
        equalOutputs(await pending, expected);
      });
    } finally {
      worker.dispose();
    }
  },
);

workerTest(
  "SDK worker kills running Wasm on timeout or abort and can restart",
  async () => {
    const { modules } = await fixture();
    const compilerBytes = sharedBytes(modules.compiler as Uint8Array);
    const rustBytes = sharedBytes(modules.generators.rust as Uint8Array);
    const loopBytes = sharedBytes(loopGuest);
    const worker = await createWorkerCompiler(workerURL, {
      compiler: compilerBytes,
      generators: { cpp: loopBytes, rust: rustBytes },
    });
    // SharedArrayBuffer survives structuredClone; restart snapshots must copy it.
    compilerBytes.fill(0);
    rustBytes.fill(0);
    loopBytes.fill(0);
    const job = simpleRequest();
    const recoveryJob: CompileRequest = { ...job, generators: ["rust"] };
    const expected = await (await createCompiler(modules)).compile(recoveryJob);
    try {
      const timeout = worker.compile(job, { timeoutMs: 100 });
      await rejects(() => worker.compile(job), "Error", "active job");
      await rejects(() => timeout, "TimeoutError");
      equalOutputs(await worker.compile(recoveryJob), expected);

      const controller = new AbortController();
      const aborted = worker.compile(job, { signal: controller.signal });
      const abortTimer = setTimeout(() => controller.abort(), 100);
      try {
        await rejects(() => aborted, "AbortError");
      } finally {
        clearTimeout(abortTimer);
      }
      equalOutputs(await worker.compile(recoveryJob), expected);
      const alreadyAborted = AbortSignal.abort();
      await rejects(
        () => worker.compile(job, { signal: alreadyAborted }),
        "AbortError",
      );
      for (const timeoutMs of [0, -1, NaN, Infinity, 2_147_483_648]) {
        await rejects(
          () => worker.compile(job, { timeoutMs }),
          "TypeError",
          "timeoutMs",
        );
      }
      const disposed = worker.compile(job);
      worker.dispose();
      await rejects(() => disposed, "Error", "disposed");
    } finally {
      worker.dispose();
    }
  },
);

Deno.test("SDK bounds aggregate workspace bytes and entries before executing", async () => {
  const compiler = await createCompiler({
    compiler: malformedRequestGuest,
    generators: {},
  }, {
    limits: { workspaceBytes: 5, workspaceEntries: 3, pathBytes: 8 },
  });
  for (const bytes of [4, 5]) {
    const result = await compiler.compile({
      files: { "a/b": "é" },
      includeFiles: { c: new Uint8Array(bytes - 2) },
      entrypoints: ["a/b"],
      generators: [],
    });
    equalBytes(result.request, encoder.encode("x"), "bounded request");
  }
  await rejects(
    () =>
      compiler.compile({
        files: { "a/b": "é" },
        includeFiles: { c: new Uint8Array(4) },
        entrypoints: ["a/b"],
        generators: [],
      }),
    "TypeError",
    "workspaceBytes",
  );
  await rejects(
    () =>
      compiler.compile({
        files: { "a/b": "" },
        includeFiles: { "c/d": "" },
        entrypoints: ["a/b"],
        generators: [],
      }),
    "TypeError",
    "workspaceEntries",
  );
  await rejects(
    () =>
      compiler.compile({
        files: { "ééééx": "" },
        entrypoints: ["ééééx"],
        generators: [],
      }),
    "TypeError",
    "pathBytes",
  );
});

function leb(value: number): number[] {
  const bytes: number[] = [];
  do {
    const part = value & 127;
    value = Math.floor(value / 128);
    bytes.push(part | (value ? 128 : 0));
  } while (value);
  return bytes;
}
function section(id: number, bytes: number[]): number[] {
  return [id, ...leb(bytes.length), ...bytes];
}
function name(value: string): number[] {
  const bytes = [...encoder.encode(value)];
  return [...leb(bytes.length), ...bytes];
}
function commandGuest(
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
const writeX = [0x41, 1, 0x41, 0, 0x41, 1, 0x41, 12, 0x10, 0, 0x1a];

Deno.test("SDK caps unbounded and larger guest memories before execution", async () => {
  // Grow twice from one page, then emit memory.size as a byte. Two-page ceiling
  // makes the second growth fail inside Wasm without allocating a third page.
  const code = [
    0x41,
    1,
    0x40,
    0,
    0x1a,
    0x41,
    1,
    0x40,
    0,
    0x1a,
    0x41,
    8,
    0x3f,
    0,
    0x3a,
    0,
    0,
    ...writeX,
  ];
  for (const memory of [[0, 1], [1, 1, 3], [1, 1, 1]]) {
    const compiler = await createCompiler({
      compiler: commandGuest(code, undefined, memory),
      generators: {},
    }, { limits: { memoryPages: 2 } });
    const result = await compiler.compile({
      files: { a: "" },
      entrypoints: ["a"],
      generators: [],
    });
    equalBytes(
      result.request,
      new Uint8Array([memory[2] === 1 ? 1 : 2]),
      "memory ceiling",
    );
  }
  await rejects(
    () =>
      createCompiler({
        compiler: commandGuest(writeX, undefined, [0, 3]),
        generators: {},
      }, { limits: { memoryPages: 2 } }),
    "TypeError",
    "memoryPages",
  );
  await rejects(
    () =>
      createCompiler({
        compiler: awaitCompiledGuest as unknown as Uint8Array,
        generators: {},
      }),
    "TypeError",
    "bytes",
  );
});
const awaitCompiledGuest = await WebAssembly.compile(
  new Uint8Array(malformedRequestGuest),
);

Deno.test("SDK bounds command stdout and stderr while preserving diagnostics", async () => {
  for (const count of [1, 2, 3]) {
    const guest = commandGuest(
      Array.from({ length: count }, () => writeX).flat(),
    );
    const compiler = await createCompiler({ compiler: guest, generators: {} }, {
      limits: { stdoutBytes: 2 },
    });
    const run = () =>
      compiler.compile({
        files: { a: "" },
        entrypoints: ["a"],
        generators: [],
      });
    if (count <= 2) {
      equalBytes(
        (await run()).request,
        encoder.encode("x".repeat(count)),
        "stdout boundary",
      );
    } else await rejects(run, "CompileError", "stdoutBytes");
  }
  const stderrWrite = [...writeX];
  stderrWrite[1] = 2;
  const noisy = await createCompiler({
    compiler: commandGuest([...stderrWrite, ...stderrWrite]),
    generators: {},
  }, { limits: { stderrBytes: 1 } });
  const failure = await rejects(
    () =>
      noisy.compile({ files: { a: "" }, entrypoints: ["a"], generators: [] }),
    "CompileError",
    "stderrBytes",
  );
  assert(
    failure instanceof CompileError && failure.diagnostics[0]?.stderr === "x",
    "stderr limit lost captured prefix",
  );
  assert(!("outputs" in failure), "resource failure published output");
});

Deno.test("SDK accounts resizable buffer growth for stdout and stderr", async () => {
  // Seven single-byte writes exercise both replacement and in-place ArrayBuffer
  // growth; checking only a two-byte ceiling never reaches an in-place resize.
  for (const stream of ["stdoutBytes", "stderrBytes"] as const) {
    for (const count of [5, 6, 7]) {
      const write = [...writeX];
      write[1] = stream === "stdoutBytes" ? 1 : 2;
      const code = Array.from({ length: count }, () => write).flat();
      if (stream === "stderrBytes") code.push(...writeX);
      const compiler = await createCompiler({
        compiler: commandGuest(code),
        generators: {},
      }, { limits: { [stream]: 6 } });
      const run = () =>
        compiler.compile({
          files: { a: "" },
          entrypoints: ["a"],
          generators: [],
        });
      if (count <= 6) {
        const result = await run();
        equalBytes(
          result.request,
          encoder.encode("x".repeat(stream === "stdoutBytes" ? count : 1)),
          `${stream} boundary`,
        );
        if (stream === "stderrBytes") {
          assert(
            result.diagnostics[0]?.stderr === "x".repeat(count),
            "stderr prefix differs",
          );
        }
      } else {
        const failure = await rejects(run, "CompileError", stream);
        assert(
          !("outputs" in failure),
          "stream quota failure published outputs",
        );
        if (stream === "stderrBytes") {
          assert(
            failure instanceof CompileError,
            "stderr quota lost CompileError",
          );
          assert(
            failure.diagnostics[0]?.stderr === "xxxxxx",
            "stderr quota lost its bounded prefix",
          );
        }
      }
    }
  }
});

workerTest(
  "SDK worker propagates limits through failures, cancellation, and restart",
  async () => {
    const worker = await createWorkerCompiler(workerURL, {
      compiler: commandGuest([...writeX, ...writeX]),
      generators: {
        cpp: loopGuest,
        rust: commandGuest([]),
        zig: commandGuest([...writeX, ...writeX, ...writeX]),
      },
    }, {
      limits: {
        workspaceBytes: 2,
        requestBytes: 2,
        stdoutBytes: 2,
        memoryPages: 1,
      },
    });
    const job = {
      files: { a: "é" },
      entrypoints: ["a"],
      generators: [] as const,
    };
    try {
      equalBytes(
        (await worker.compile(job)).request,
        encoder.encode("xx"),
        "worker limits",
      );
      await rejects(
        () => worker.compile({ ...job, files: { a: "éx" } }),
        "TypeError",
        "workspaceBytes",
      );
      await rejects(
        () =>
          worker.generate({ request: new Uint8Array(3), generators: ["rust"] }),
        "TypeError",
        "requestBytes",
      );
      await rejects(
        () =>
          worker.generate({ request: new Uint8Array(1), generators: ["cpp"] }, {
            timeoutMs: 50,
          }),
        "TimeoutError",
      );
      const failure = await rejects(
        () =>
          worker.generate({
            request: new Uint8Array(1),
            generators: ["rust", "zig"],
          }),
        "CompileError",
        "stdoutBytes",
      );
      assert(
        failure instanceof CompileError && failure.stage === "zig" &&
          !("outputs" in failure),
        "worker published earlier output after failure",
      );
      equalBytes(
        (await worker.compile(job)).request,
        encoder.encode("xx"),
        "restarted worker limits",
      );
    } finally {
      worker.dispose();
    }
  },
);

Deno.test("SDK bounds aggregate generator files at exact byte and entry boundaries", async () => {
  const { modules } = await fixture();
  const baseline = await (await createCompiler(modules)).compile(
    simpleRequest(),
  );
  const files = baseline.outputs.cpp!;
  const bytes = Object.values(files).reduce(
    (sum, data) => sum + data.length,
    0,
  );
  const entries = Object.keys(files).length;
  for (const extra of [0, 1]) {
    const bounded = await createCompiler(modules, {
      limits: { outputBytes: bytes + extra, outputEntries: entries + extra },
    });
    equalOutputs(
      await bounded.generate({
        request: baseline.request,
        generators: ["cpp"],
      }),
      baseline,
    );
  }
  for (
    const limits of [{ outputBytes: bytes - 1 }, { outputEntries: entries - 1 }]
  ) {
    const bounded = await createCompiler(modules, { limits });
    const failure = await rejects(
      () =>
        bounded.generate({ request: baseline.request, generators: ["cpp"] }),
      "CompileError",
      Object.keys(limits)[0],
    );
    assert(!("outputs" in failure), "filesystem failure published output");
  }
});

function signedLeb(value: bigint): number[] {
  const bytes: number[] = [];
  for (;;) {
    const part = Number(value & 127n);
    value >>= 7n;
    const done = value === 0n && (part & 64) === 0 ||
      value === -1n && (part & 64) !== 0;
    bytes.push(part | (done ? 0 : 128));
    if (done) return bytes;
  }
}
function filesystemGuest(
  operation: "allocate" | "resize" | "pwrite" | "recreate" | "grow-truncate",
  size: bigint,
): Uint8Array {
  const i32 = 0x7f, i64 = 0x7e;
  const signatures = [
    [i32, i32, i32, i32],
    [i32, i32, i32, i32, i32, i64, i64, i32, i32],
    [i32, i64, i64],
    [i32, i64],
    [i32, i32, i32, i64, i32],
    [i32, i32],
    [i32, i32, i32],
  ];
  const imports = [
    "fd_write",
    "path_open",
    "fd_allocate",
    "fd_filestat_set_size",
    "fd_pwrite",
    "fd_renumber",
    "path_unlink_file",
  ];
  const open = [
    0x41,
    3,
    0x41,
    0,
    0x41,
    32,
    0x41,
    1,
    0x41,
    1,
    0x42,
    0,
    0x42,
    0,
    0x41,
    0,
    0x41,
    16,
    0x10,
    1,
    0x1a,
  ];
  // Rename the returned fd so budgets must follow descriptors, not numeric slots.
  const code = [...open, 0x41, 16, 0x28, 2, 0, 0x41, 1, 0x10, 5, 0x1a];
  if (operation === "allocate") {
    code.push(0x41, 1, 0x42, 0, 0x42, ...signedLeb(size), 0x10, 2, 0x1a);
  }
  if (operation === "resize") {
    code.push(0x41, 1, 0x42, ...signedLeb(size), 0x10, 3, 0x1a);
  }
  if (operation === "pwrite") {
    code.push(
      0x41,
      1,
      0x41,
      0,
      0x41,
      1,
      0x42,
      ...signedLeb(size - 1n),
      0x41,
      12,
      0x10,
      4,
      0x1a,
    );
  }
  if (operation === "recreate") {
    code.push(0x41, 3, 0x41, 32, 0x41, 1, 0x10, 6, 0x1a, ...open);
  }
  if (operation === "grow-truncate") {
    for (let i = 0n; i < size; i++) code.push(...writeX);
    // A late collectFiles check cannot catch an overage erased before return.
    code.push(0x41, 1, 0x42, 0, 0x10, 3, 0x1a);
  }
  const body = [0, ...code, 0x0b];
  const data = Array<number>(33).fill(0);
  data[0] = 8;
  data[4] = 1;
  data[8] = 120;
  data[32] = 97;
  return new Uint8Array([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(1, [
      8,
      ...signatures.flatMap((
        parameters,
      ) => [0x60, parameters.length, ...parameters, 1, i32]),
      0x60,
      0,
      0,
    ]),
    ...section(2, [
      7,
      ...imports.flatMap((
        value,
        index,
      ) => [...name("wasi_snapshot_preview1"), ...name(value), 0, index]),
    ]),
    ...section(3, [1, 7]),
    ...section(5, [1, 0, 1]),
    ...section(7, [2, ...name("memory"), 2, 0, ...name("_start"), 0, 7]),
    ...section(10, [1, ...leb(body.length), ...body]),
    ...section(11, [1, 0, 0x41, 0, 0x0b, ...leb(data.length), ...data]),
  ]);
}

Deno.test("SDK rejects oversized file allocation, truncate, sparse writes, and inode churn", async () => {
  for (const operation of ["allocate", "resize", "pwrite"] as const) {
    for (const size of [3n, 4n, 5n, 1n << 54n]) {
      const compiler = await createCompiler({
        compiler: malformedRequestGuest,
        generators: { cpp: filesystemGuest(operation, size) },
      }, { limits: { outputBytes: 4, outputEntries: 1 } });
      const run = () =>
        compiler.generate({ request: new Uint8Array(1), generators: ["cpp"] });
      if (size <= 4n) {
        assert(
          (await run()).outputs.cpp.a.length === Number(size),
          `${operation} exact boundary failed`,
        );
      } else await rejects(run, "CompileError", "outputBytes");
    }
  }
  const compiler = await createCompiler({
    compiler: malformedRequestGuest,
    generators: { cpp: filesystemGuest("recreate", 0n) },
  }, { limits: { outputEntries: 1 } });
  await rejects(
    () =>
      compiler.generate({ request: new Uint8Array(1), generators: ["cpp"] }),
    "CompileError",
    "outputEntries",
  );
});

Deno.test("SDK bounds resizable file growth before a later truncate", async () => {
  for (const size of [5n, 6n, 7n]) {
    const compiler = await createCompiler({
      compiler: malformedRequestGuest,
      generators: { cpp: filesystemGuest("grow-truncate", size) },
    }, { limits: { outputBytes: 6, outputEntries: 1 } });
    const run = () =>
      compiler.generate({ request: new Uint8Array(1), generators: ["cpp"] });
    if (size <= 6n) {
      assert(
        (await run()).outputs.cpp.a.length === 0,
        "permitted growth did not truncate",
      );
    } else {
      const failure = await rejects(run, "CompileError", "outputBytes");
      assert(
        !("outputs" in failure),
        "truncation erased a peak-byte quota failure",
      );
    }
  }
});

Deno.test("SDK rejects malformed, shared, memory64, duplicate, and imported memories", async () => {
  for (
    const memory of [[3, 1, 2], [4, 1], [1, 2, 1], [0, 128, 128, 128, 128, 16]]
  ) {
    await rejects(
      () =>
        createCompiler({
          compiler: commandGuest([], undefined, memory),
          generators: {},
        }),
      "TypeError",
    );
  }
  const good = commandGuest([]);
  for (
    const bad of [
      good.slice(0, -1),
      new Uint8Array([...good, ...section(5, [1, 0, 1])]),
      new Uint8Array([...good, 0, 255, 255, 255, 255, 16]),
    ]
  ) {
    await rejects(
      () => createCompiler({ compiler: bad, generators: {} }),
      "TypeError",
    );
  }
  const originalImport = section(2, [
    1,
    ...name("wasi_snapshot_preview1"),
    ...name("fd_write"),
    0,
    0,
  ]);
  const extendedImport = section(2, [
    2,
    ...originalImport.slice(3),
    ...name("env"),
    ...name("memory"),
    2,
    0,
    1,
  ]);
  const start = good.findIndex((_, index) =>
    originalImport.every((value, part) => good[index + part] === value)
  );
  assert(start > 0, "test import fixture not found");
  const imported = new Uint8Array([
    ...good.slice(0, start),
    ...extendedImport,
    ...good.slice(start + originalImport.length),
  ]);
  await rejects(
    () => createCompiler({ compiler: imported, generators: {} }),
    "TypeError",
    "imported",
  );
});

Deno.test("SDK path limits count user paths separately from internal mount and root probes", async () => {
  const { modules } = await fixture();
  for (const path of ["a", "é", "a/b"]) {
    const compiler = await createCompiler({
      compiler: modules.compiler,
      generators: {},
    }, { limits: { pathBytes: encoder.encode(path).length } });
    const input = {
      files: { [path]: "@0xece4bf9c1f867623; struct Foo {}" },
      entrypoints: [path],
      generators: [] as const,
    };
    assert(
      (await compiler.compile(input)).request.length > 0,
      "valid short path was blocked by internal root lookup",
    );
    await rejects(
      () =>
        compiler.compile({
          ...input,
          files: { [path + "x"]: "" },
          entrypoints: [path + "x"],
        }),
      "TypeError",
      "pathBytes",
    );
  }
  const writer = await createCompiler({
    compiler: malformedRequestGuest,
    generators: { cpp: filesystemGuest("allocate", 1n) },
  }, { limits: { pathBytes: 0 } });
  await rejects(
    () => writer.generate({ request: new Uint8Array(1), generators: ["cpp"] }),
    "CompileError",
    "pathBytes",
  );
});
