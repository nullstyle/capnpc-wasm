import {
  checkWorkerRuntime,
  detectWorkerRuntime,
  isBoundedWorkerSupported,
  supportedDenoWorkerVersion,
  supportsWasmExceptions as supportsFromEnvironment,
} from "./environment.ts";
import {
  createCompiler,
  createWorkerCompiler,
  supportsWasmExceptions,
} from "./mod.ts";
import {
  assert,
  rejects,
  rejectsWith,
  trapGuest,
  workerURL,
} from "./testdata/support.ts";

Deno.test("SDK classifies worker runtimes from their globals", () => {
  const cases: [
    Record<string, unknown>,
    ReturnType<typeof detectWorkerRuntime>,
  ][] = [
    [
      {
        Deno: { version: { deno: "2.6.8" } },
        process: { versions: { node: "24.2.0", deno: "2.6.8" } },
        navigator: {},
        Worker: class {},
      },
      { kind: "deno", version: "2.6.8" },
    ],
    [
      { Bun: {}, process: { versions: { node: "24.0.0", bun: "1.3.14" } } },
      { kind: "bun" },
    ],
    [{ process: { versions: { bun: "1.3.14" } } }, { kind: "bun" }],
    [
      { process: { versions: { node: "24.0.0" } }, Worker: class {} },
      { kind: "node" },
    ],
    [{ Worker: class {}, navigator: {}, document: {} }, { kind: "browser" }],
    [
      { Worker: class {}, navigator: {}, WorkerGlobalScope: class {} },
      { kind: "browser" },
    ],
    [{ Worker: class {}, navigator: {} }, { kind: "unknown" }],
    [{ document: {}, navigator: {} }, { kind: "unknown" }],
    [{}, { kind: "unknown" }],
  ];
  for (const [globals, expected] of cases) {
    const actual = detectWorkerRuntime(globals);
    assert(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${JSON.stringify(Object.keys(globals))}: ${JSON.stringify(actual)}`,
    );
  }
  assert(
    detectWorkerRuntime().kind === "deno",
    "the test host was not recognized as Deno",
  );
});

Deno.test("SDK admits worker execution in browsers, on every Deno release, and on Bun", () => {
  const admitted: [Record<string, unknown>, string][] = [
    [{ Deno: { version: { deno: "2.6.8" } } }, "deno"],
    [{ Deno: { version: { deno: "2.9.6" } } }, "deno"],
    [{ Deno: { version: { deno: "3.0.0" } } }, "deno"],
    [{ Worker: class {}, navigator: {}, document: {} }, "browser"],
    [{ Bun: {} }, "bun"],
  ];
  for (const [globals, kind] of admitted) {
    const { runtime } = checkWorkerRuntime(globals);
    assert(
      runtime.kind === kind,
      `${JSON.stringify(globals)} was not admitted`,
    );
  }
  const rejections: [Record<string, unknown>, string][] = [
    [
      { process: { versions: { node: "24.0.0" } } },
      "Node.js has no Web Worker",
    ],
    [{}, "supported in browsers, Deno and Bun only"],
  ];
  for (const [globals, expected] of rejections) {
    let thrown: unknown;
    try {
      checkWorkerRuntime(globals);
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof Error && thrown.message.includes(expected) &&
        thrown.message.includes("createCompiler"),
      `${JSON.stringify(globals)}: ${thrown}`,
    );
  }
  // Deprecated, kept for existing importers; the SDK no longer checks it.
  assert(supportedDenoWorkerVersion === "2.6.8", "deprecated export changed");
});

Deno.test("SDK worker factory rejects Node.js and unknown hosts before creating a worker", async () => {
  const deno = Object.getOwnPropertyDescriptor(globalThis, "Deno")!;
  // Deno's `process` is a lazy getter that reads Deno.build; shadow it
  // before hiding Deno, and restore both descriptors afterwards.
  const process = Object.getOwnPropertyDescriptor(globalThis, "process");
  const RealWorker = globalThis.Worker;
  let constructions = 0;
  globalThis.Worker = class extends RealWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      constructions++;
      super(url, options);
    }
  };
  const modules = { compiler: trapGuest, generators: {} };
  const host = (value: unknown) =>
    Object.defineProperty(globalThis, "process", {
      value,
      configurable: true,
      writable: true,
    });
  try {
    host(undefined);
    Object.defineProperty(globalThis, "Deno", {
      value: undefined,
      configurable: true,
    });
    await rejects(
      () => createWorkerCompiler(workerURL, modules),
      "Error",
      "supported in browsers, Deno and Bun only",
    );
    host({ versions: { node: "24.0.0" } });
    await rejects(
      () => createWorkerCompiler(workerURL, modules),
      "Error",
      "Node.js has no Web Worker",
    );
  } finally {
    if (process) Object.defineProperty(globalThis, "process", process);
    else delete (globalThis as { process?: unknown }).process;
    Object.defineProperty(globalThis, "Deno", deno);
    globalThis.Worker = RealWorker;
  }
  assert(constructions === 0, "a worker was created for a rejected runtime");
  assert(detectWorkerRuntime().kind === "deno", "Deno global was not restored");
});

Deno.test("SDK detects standardized Wasm exception handling before compiling", async () => {
  assert(supportsWasmExceptions === supportsFromEnvironment, "export differs");
  assert(supportsWasmExceptions(), "the pinned Deno validates exnref");
  const original = WebAssembly.validate;
  const RealWorker = globalThis.Worker;
  let constructions = 0;
  globalThis.Worker = class extends RealWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      constructions++;
      super(url, options);
    }
  };
  try {
    WebAssembly.validate = () => false;
    assert(!supportsWasmExceptions(), "stubbed validate was ignored");
    const direct = await rejectsWith(
      () => createCompiler({ compiler: trapGuest, generators: {} }),
      TypeError,
    );
    assert(
      direct.message.includes("exception handling") &&
        direct.message.includes("update"),
      direct.message,
    );
    await rejectsWith(
      () =>
        createWorkerCompiler(workerURL, {
          compiler: trapGuest,
          generators: {},
        }),
      TypeError,
      direct.message,
    );
    assert(constructions === 0, "a worker was created on an old engine");
    WebAssembly.validate = () => {
      throw new Error("validate unavailable");
    };
    assert(!supportsWasmExceptions(), "a throwing validate was not handled");
  } finally {
    WebAssembly.validate = original;
    globalThis.Worker = RealWorker;
  }
  assert(supportsWasmExceptions(), "validate was not restored");
});

Deno.test("SDK reports bounded worker support as a predicate", () => {
  assert(
    isBoundedWorkerSupported({ Deno: { version: { deno: "2.9.6" } } }) &&
      isBoundedWorkerSupported({ Bun: {} }) &&
      isBoundedWorkerSupported({
        Worker: class {},
        navigator: {},
        document: {},
      }),
    "worker hosts were not reported as supported",
  );
  assert(
    !isBoundedWorkerSupported({
      process: { versions: { node: "24.0.0" } },
    }) && !isBoundedWorkerSupported({}),
    "hosts without a module Worker were reported as supported",
  );
  assert(isBoundedWorkerSupported(), "the test host was not admitted");
});
