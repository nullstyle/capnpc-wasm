import {
  CompileError,
  type CompileRequest,
  type CompileResult,
  createCompiler,
  createWorkerCompiler,
  type Modules,
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
  for (const language of ["cpp", "rust", "go"] as const) {
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

function wasm(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
}

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
      person,
      common,
      cxxAnnotations,
      goAnnotations,
    ] = await Promise.all([
      read("build/wasm/bin/capnp.wasm"),
      read("build/wasm/bin/capnpc-c++.wasm"),
      read("build/wasm/bin/capnpc-rust.wasm"),
      read("build/wasm/bin/capnpc-go.wasm"),
      read("tests/fixtures/schemas/person.capnp"),
      read("tests/fixtures/schemas/types/common.capnp"),
      read("ref/capnproto/c++/src/capnp/c++.capnp"),
      read("ref/go-capnp/std/go.capnp"),
    ]);
    return {
      modules: { compiler, generators: { cpp, rust, go } },
      request: {
        files: { "person.capnp": person, "types/common.capnp": common },
        includeFiles: {
          "capnp/c++.capnp": cxxAnnotations,
          "go.capnp": goAnnotations,
        },
        entrypoints: ["person.capnp", "types/common.capnp"],
        generators: ["cpp", "rust", "go"],
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
  // Accept both compiled modules and bytes in the same module set.
  const compiler = await createCompiler({
    ...modules,
    compiler: await WebAssembly.compile(
      new Uint8Array(modules.compiler as Uint8Array),
    ),
  });
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
  };
  for (const language of ["cpp", "rust", "go"] as const) {
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
  for (const language of ["cpp", "rust", "go"] as const) {
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

  for (const generators of [[], ["cpp", "cpp"], ["zig"]]) {
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

Deno.test("SDK worker generates saved requests with hard cancellation and reuse", async () => {
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
});

Deno.test("SDK worker matches core output and preserves errors", async () => {
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

Deno.test("SDK worker snapshots shared request and workspace bytes", async (t) => {
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
        const bytes of [...Object.values(files), ...Object.values(includeFiles)]
      ) {
        bytes.fill(0);
      }
      equalOutputs(await pending, expected);
    });
  } finally {
    worker.dispose();
  }
});

Deno.test("SDK worker kills running Wasm on timeout or abort and can restart", async () => {
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
});
