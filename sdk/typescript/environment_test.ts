import {
  checkWorkerRuntime,
  detectWorkerRuntime,
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

Deno.test("SDK admits worker execution in browsers and on the verified Deno only", () => {
  const supported = checkWorkerRuntime({
    Deno: { version: { deno: supportedDenoWorkerVersion } },
  });
  assert(
    supported.runtime.kind === "deno" && supported.terminationGraceMs === 2100,
    "verified Deno was not admitted with its termination grace",
  );
  const browser = checkWorkerRuntime({
    Worker: class {},
    navigator: {},
    document: {},
  });
  assert(
    browser.runtime.kind === "browser" && browser.terminationGraceMs === 0,
    "browser was not admitted",
  );
  const rejections: [Record<string, unknown>, string][] = [
    [
      { Deno: { version: { deno: "2.9.6" } } },
      `use Deno ${supportedDenoWorkerVersion}`,
    ],
    [{ Bun: {} }, "Bun worker termination is not verified"],
    [
      { process: { versions: { node: "24.0.0" } } },
      "Node.js worker termination is not verified",
    ],
    [{}, "supported in browsers and on Deno"],
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
});

Deno.test("SDK worker factory rejects Bun and Node before creating a worker", async () => {
  const deno = Object.getOwnPropertyDescriptor(globalThis, "Deno")!;
  const RealWorker = globalThis.Worker;
  let constructions = 0;
  globalThis.Worker = class extends RealWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      constructions++;
      super(url, options);
    }
  };
  const modules = { compiler: trapGuest, generators: {} };
  try {
    Object.defineProperty(globalThis, "Deno", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(globalThis, "Bun", {
      value: { version: "1.3.14" },
      configurable: true,
    });
    await rejects(
      () => createWorkerCompiler(workerURL, modules),
      "Error",
      "Bun worker termination is not verified",
    );
    delete (globalThis as { Bun?: unknown }).Bun;
    Object.defineProperty(globalThis, "process", {
      value: { versions: { node: "24.0.0" } },
      configurable: true,
      writable: true,
    });
    await rejects(
      () => createWorkerCompiler(workerURL, modules),
      "Error",
      "Node.js worker termination is not verified",
    );
  } finally {
    delete (globalThis as { Bun?: unknown }).Bun;
    delete (globalThis as { process?: unknown }).process;
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
    if (Deno.version.deno === supportedDenoWorkerVersion) {
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
    }
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
