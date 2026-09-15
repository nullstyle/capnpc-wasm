import {
  CompileError,
  type CompileRequest,
  createCompiler,
  createWorkerCompiler,
  supportedDenoWorkerVersion,
} from "@nullstyle/capnp-wasm-compiler-host";

const root = new URL(
  "./node_modules/@nullstyle/capnp-wasm-compiler-host/",
  import.meta.url,
);
const compilerBytes = await Deno.readFile(new URL("wasm/capnp.wasm", root));
const workerBytes = await Deno.readFile(new URL("typescript/worker.js", root));
const standard = await Deno.readFile(
  new URL("include/capnp/stream.capnp", root),
);
const annotations = await Deno.readFile(
  new URL("include/capnp/c++.capnp", root),
);
const workerURL = URL.createObjectURL(
  new Blob([workerBytes], { type: "text/javascript" }),
);
// Deterministic infinite guest, not an additional packaged language generator.
// (module (memory (export "memory") 1) (func (export "_start") (loop (br 0))))
const loopGuest = Uint8Array.from(
  "0061736d01000000010401600000030201000503010001071302066d656d6f72790200065f737461727400000a0901070003400c000b0b"
    .match(/../g)!,
  (value) => parseInt(value, 16),
);
const modules = { compiler: compilerBytes, generators: {} };
const request: CompileRequest = {
  files: {
    "space dir/candidate.capnp":
      '@0xece4bf9c1f867623; using Common = import "../common.capnp"; struct Candidate { value @0 :Common.Value; data @1 :Data = embed "../bytes.bin"; } interface Sink { send @0 (value :Candidate) -> stream; }',
    "common.capnp": "@0x9c9e5ec72c9f6a21; struct Value { id @0 :UInt64; }",
    "bytes.bin": new Uint8Array([0, 255, 128, 42]),
  },
  includeFiles: {
    "capnp/stream.capnp": standard,
    "capnp/c++.capnp": annotations,
  },
  entrypoints: ["space dir/candidate.capnp"],
  generators: [],
};
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function rejects(
  operation: () => Promise<unknown>,
  name: string,
): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof Error, "failure is not an Error");
    assert(error.name === name, `expected ${name}, received ${error}`);
    return error;
  }
  throw new Error(`expected ${name}`);
}
async function digest(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
  ].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// All assets are loaded. Jobs and worker restarts require no host permissions.
await Deno.permissions.revoke({ name: "read" });
const compiler = await createCompiler(modules);
const result = await compiler.compile(request);
assert(result.request.length > 0, "compiler produced no request");
assert(Object.keys(result.outputs).length === 0, "unexpected generator output");
const expectedHash = await digest(result.request);
const worker = Deno.version.deno === supportedDenoWorkerVersion
  ? await createWorkerCompiler(workerURL, {
    ...modules,
    generators: { cpp: loopGuest },
  })
  : undefined;
if (!worker) {
  const error = await rejects(
    () => createWorkerCompiler(workerURL, modules),
    "Error",
  );
  assert(
    error.message.includes(`use Deno ${supportedDenoWorkerVersion}`),
    "runtime guidance lost",
  );
}
try {
  if (worker) {
    assert(
      await digest((await worker.compile(request)).request) === expectedHash,
      "direct and worker requests differ",
    );
  }
  const invalid = {
    ...request,
    files: { "broken.capnp": "@0xece4bf9c1f867623; struct Broken { invalid" },
    entrypoints: ["broken.capnp"],
  };
  const failure = await rejects(
    () => (worker ?? compiler).compile(invalid),
    "CompileError",
  );
  assert(failure instanceof CompileError, "structured compiler error lost");
  assert(failure.stage === "compiler", "compiler failure stage lost");
  assert(failure.exitCode !== undefined && failure.exitCode !== 0, "exit lost");
  assert(
    failure.diagnostics.some((item) => item.stderr.includes("broken.capnp")),
    "source diagnostic lost",
  );
  assert(!("outputs" in failure), "failed compilation exposed outputs");
  if (worker) {
    assert(
      await digest((await worker.compile(request)).request) === expectedHash,
      "worker did not recover from malformed input",
    );
  }
  if (worker) {
    for (const mode of ["timeout", "abort"] as const) {
      const controller = new AbortController();
      const pending = worker.compile({ ...request, generators: ["cpp"] }, {
        timeoutMs: mode === "timeout" ? 100 : 5000,
        signal: controller.signal,
      });
      const timer = mode === "abort"
        ? setTimeout(() => controller.abort(), 100)
        : undefined;
      try {
        await rejects(
          () => pending,
          mode === "timeout" ? "TimeoutError" : "AbortError",
        );
      } finally {
        clearTimeout(timer);
      }
      assert(
        await digest((await worker.compile(request)).request) === expectedHash,
        `worker did not recover after ${mode}`,
      );
    }
  }
  const limited = await createCompiler(modules, {
    limits: { requestBytes: 1 },
  });
  await rejects(() => limited.compile(request), "CompileError");
  await rejects(
    () => compiler.compile({ ...request, includeFiles: {} }),
    "CompileError",
  );
  await rejects(
    () => compiler.compile({ ...request, generators: ["zig"] }),
    "TypeError",
  );
  console.log(JSON.stringify({
    deno: Deno.version.deno,
    requestSha256: expectedHash,
    requestBytes: result.request.length,
    checks: [
      "external npm exports and TypeScript declarations",
      ...(worker
        ? ["direct and worker compiler request parity"]
        : ["unsupported Deno worker version rejected before execution"]),
      "imports, spaces, binary embeds and bundled streaming schema",
      "no process or network permission; read revoked before execution",
      "malformed input diagnostics",
      ...(worker
        ? [
          "worker recovery and offline restart after termination grace",
          "active guest timeout and abort",
        ]
        : []),
      "request resource limit and standard include isolation",
      "missing generator rejection",
    ],
  }));
} finally {
  worker?.dispose();
  URL.revokeObjectURL(workerURL);
}
