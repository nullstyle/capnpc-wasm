/**
 * Worker-client behaviour that the shared output tests cannot see: which
 * failures restart the worker, that errors cross the boundary with the direct
 * compiler's classes and messages, result shapes, and the client's state
 * machine around load failures, initialization, and disposal. These run on
 * the verified Deno worker release only.
 */
import {
  CompileError,
  type Compiler,
  type CompileRequest,
  createCompiler,
  createWorkerCompiler,
  type Files,
  type Modules,
  type WorkerCompiler,
} from "./mod.ts";
import { hostileGuests } from "./testdata/hostile_guests.ts";
import { resolveWorkerURL } from "./worker-client.ts";
import {
  assert,
  commandGuest,
  encoder,
  equalBytes,
  equalOutputs,
  fixture,
  loopGuest,
  rejects,
  rejectsWith,
  simpleRequest,
  stderrTrapGuest,
  trapGuest,
  workerTest,
  workerURL,
  writeX,
} from "./testdata/support.ts";

/** Count Worker constructions while `run` executes. */
async function countingWorkers<T>(
  run: (constructions: () => number) => Promise<T>,
): Promise<T> {
  const RealWorker = globalThis.Worker;
  let constructions = 0;
  globalThis.Worker = class extends RealWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      constructions++;
      super(url, options);
    }
  };
  try {
    return await run(() => constructions);
  } finally {
    globalThis.Worker = RealWorker;
  }
}

async function timed<T>(run: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const value = await run();
  return [value, performance.now() - started];
}

workerTest(
  "SDK worker keeps its worker after ordinary job errors",
  async () => {
    const { modules, request } = await fixture();
    const expected = await (await createCompiler(modules)).compile(request);
    await countingWorkers(async (constructions) => {
      const worker = await createWorkerCompiler(workerURL, modules);
      try {
        equalOutputs(await worker.compile(request), expected);
        assert(constructions() === 1, "unexpected worker count after start");
        const failures: [
          string,
          new (...args: never[]) => Error,
          () => Promise<unknown>,
        ][] = [
          ["schema error", CompileError, () =>
            worker.compile({
              ...request,
              files: { ...request.files, "person.capnp": "invalid schema" },
            })],
          [
            "duplicate generators",
            TypeError,
            () => worker.compile({ ...request, generators: ["cpp", "cpp"] }),
          ],
          [
            "empty entrypoints",
            TypeError,
            () => worker.compile({ ...request, entrypoints: [] }),
          ],
          ["malformed request", CompileError, () =>
            worker.generate({
              request: expected.request.slice(0, 12),
              generators: ["rust"],
            })],
        ];
        for (const [label, expectedClass, fail] of failures) {
          let thrown: unknown;
          try {
            await fail();
          } catch (error) {
            thrown = error;
          }
          assert(
            thrown instanceof expectedClass &&
              Object.getPrototypeOf(thrown) === expectedClass.prototype,
            `${label}: expected ${expectedClass.name}, received ${thrown}`,
          );
          // No restart: the same worker answers at once, well inside the
          // 2.1 s Deno termination grace, and short deadlines still succeed.
          const [result, elapsed] = await timed(() =>
            worker.compile(request, { timeoutMs: 1500 })
          );
          equalOutputs(result, expected);
          assert(
            constructions() === 1,
            `${label} restarted the worker (${constructions()} workers)`,
          );
          assert(elapsed < 1500, `${label}: next job took ${elapsed} ms`);
        }
        // Timeouts still terminate and replace the worker.
        await rejects(
          () =>
            worker.compile({ ...request, generators: ["cpp"] }, {
              timeoutMs: 1,
            }),
          "TimeoutError",
        );
        equalOutputs(await worker.compile(request), expected);
        assert(constructions() === 2, "timeout did not replace the worker");
      } finally {
        worker.dispose();
      }
    });
  },
);

type Outcome = {
  constructor: string;
  name: string;
  message: string;
  stage?: string;
  exitCode?: number;
  diagnostics?: string;
  causeName?: string;
  causeMessage?: string;
};

async function outcome(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    await run();
  } catch (error) {
    assert(error instanceof Error, `not an Error: ${error}`);
    const cause = error.cause;
    return {
      constructor: error.constructor.name,
      name: error.name,
      message: error.message,
      ...(error instanceof CompileError
        ? {
          stage: error.stage,
          exitCode: error.exitCode,
          diagnostics: JSON.stringify(error.diagnostics),
        }
        : {}),
      ...(cause instanceof Error
        ? { causeName: cause.name, causeMessage: cause.message }
        : {}),
    };
  }
  throw new Error("expected a rejection");
}

function same(label: string, direct: Outcome, worker: Outcome): void {
  assert(
    JSON.stringify(direct) === JSON.stringify(worker),
    `${label}: direct ${JSON.stringify(direct)} but worker ${
      JSON.stringify(worker)
    }`,
  );
}

workerTest(
  "SDK worker rejects with the direct compiler's error classes and messages",
  async () => {
    const { modules, request: fixtureRequest } = await fixture();
    const partial: Modules = {
      compiler: modules.compiler,
      generators: { cpp: modules.generators.cpp },
    };
    const direct = await createCompiler(partial);
    const worker = await createWorkerCompiler(workerURL, partial);
    const request = { ...fixtureRequest, generators: ["cpp"] as const };
    const pair = async (
      label: string,
      run: (compiler: Compiler | WorkerCompiler) => Promise<unknown>,
      expected: { constructor: string; message: string },
    ) => {
      const [fromDirect, fromWorker] = [
        await outcome(() => run(direct)),
        await outcome(() => run(worker)),
      ];
      same(label, fromDirect, fromWorker);
      assert(
        fromWorker.constructor === expected.constructor &&
          fromWorker.message === expected.message,
        `${label}: ${JSON.stringify(fromWorker)}`,
      );
      return fromWorker;
    };
    try {
      await pair(
        "missing entrypoint",
        (compiler) =>
          compiler.compile({ ...request, entrypoints: ["nope.capnp"] }),
        {
          constructor: "TypeError",
          message: "entrypoint is not in files: nope.capnp",
        },
      );
      await pair(
        "unsupplied generator",
        (compiler) => compiler.compile({ ...request, generators: ["go"] }),
        { constructor: "TypeError", message: "generator was not supplied: go" },
      );
      await pair(
        "bad path",
        (compiler) =>
          compiler.compile({
            ...request,
            files: { "../escape.capnp": "" },
            entrypoints: ["../escape.capnp"],
          }),
        {
          constructor: "TypeError",
          message: "expected a canonical relative POSIX path: ../escape.capnp",
        },
      );
      await pair(
        "string entrypoints",
        (compiler) =>
          compiler.compile({
            ...request,
            entrypoints: "person.capnp" as unknown as string[],
          }),
        {
          constructor: "TypeError",
          message: "entrypoints must be an array of paths",
        },
      );
      await pair(
        "workspace limit",
        (compiler) =>
          compiler.compile({
            ...request,
            files: { "big.capnp": new Uint8Array(64 * 1024 * 1024 + 1) },
            entrypoints: ["big.capnp"],
          }),
        {
          constructor: "TypeError",
          message: "workspace exceeds workspaceBytes limit",
        },
      );
      await pair(
        "oversized supplied request",
        (compiler) =>
          compiler.generate({
            request: new Uint8Array(64 * 1024 * 1024 + 1),
            generators: ["cpp"],
          }),
        {
          constructor: "TypeError",
          message: "request exceeds requestBytes limit",
        },
      );
      const exit = await pair(
        "schema error",
        (compiler) =>
          compiler.compile({
            ...request,
            files: { ...request.files, "person.capnp": "invalid schema" },
          }),
        {
          constructor: "CompileError",
          message: "compiler exited with status 1",
        },
      );
      assert(
        exit.stage === "compiler" && exit.exitCode === 1 &&
          exit.diagnostics!.includes("person.capnp"),
        `schema error lost details: ${JSON.stringify(exit)}`,
      );
    } finally {
      worker.dispose();
    }

    // Factory-time rejections: malformed bytes never reach an engine; bytes
    // the engine refuses come back as the same TypeError with a cause.
    const badBytes = { compiler: new Uint8Array([1, 2, 3]), generators: {} };
    same(
      "invalid module bytes",
      await outcome(() => createCompiler(badBytes)),
      await outcome(() => createWorkerCompiler(workerURL, badBytes)),
    );
    const refused = { compiler: commandGuest([0x0c, 5]), generators: {} };
    const [directRefused, workerRefused] = [
      await outcome(() => createCompiler(refused)),
      await outcome(() => createWorkerCompiler(workerURL, refused)),
    ];
    same("engine-refused module", directRefused, workerRefused);
    assert(
      workerRefused.constructor === "TypeError" &&
        workerRefused.message.startsWith(
          "the engine rejected the Wasm module",
        ) &&
        workerRefused.causeName === "CompileError",
      `engine rejection lost its cause: ${JSON.stringify(workerRefused)}`,
    );

    // Guest traps and run-time limits keep stage, diagnostics and cause.
    const trapping: Modules = { compiler: stderrTrapGuest, generators: {} };
    const trapJob: CompileRequest = { ...simpleRequest(), generators: [] };
    const trapWorker = await createWorkerCompiler(workerURL, trapping);
    try {
      const [directTrap, workerTrap] = [
        await outcome(async () =>
          (await createCompiler(trapping)).compile(trapJob)
        ),
        await outcome(() => trapWorker.compile(trapJob)),
      ];
      same("guest trap", directTrap, workerTrap);
      assert(
        workerTrap.constructor === "CompileError" &&
          workerTrap.stage === "compiler" &&
          workerTrap.exitCode === undefined &&
          workerTrap.message.startsWith("compiler trapped: ") &&
          workerTrap.causeName === "CommandError" &&
          workerTrap.diagnostics === JSON.stringify([{
              stage: "compiler",
              stderr: "x",
            }]),
        `trap lost details: ${JSON.stringify(workerTrap)}`,
      );
      const workerError = await rejectsWith(
        () => trapWorker.compile(trapJob),
        CompileError,
      );
      const chain = workerError.cause as Error;
      assert(
        chain instanceof Error && chain.cause instanceof Error &&
          chain.cause.name === "RuntimeError",
        "worker trap lost the engine error beneath the command error",
      );
    } finally {
      trapWorker.dispose();
    }
    const limited: Modules = {
      compiler: commandGuest([...writeX, ...writeX, ...writeX]),
      generators: {},
    };
    const options = { limits: { stdoutBytes: 2 } };
    const limitJob: CompileRequest = {
      files: { a: "" },
      entrypoints: ["a"],
      generators: [],
    };
    const limitWorker = await createWorkerCompiler(workerURL, limited, options);
    try {
      const [directLimit, workerLimit] = [
        await outcome(async () =>
          (await createCompiler(limited, options)).compile(limitJob)
        ),
        await outcome(() => limitWorker.compile(limitJob)),
      ];
      same("run-time limit", directLimit, workerLimit);
      assert(
        workerLimit.constructor === "CompileError" &&
          workerLimit.message.includes("stdoutBytes") &&
          workerLimit.exitCode === undefined,
        `limit lost details: ${JSON.stringify(workerLimit)}`,
      );
    } finally {
      limitWorker.dispose();
    }
  },
);

workerTest("SDK worker results have the direct compiler's shape", async () => {
  const guest = hostileGuests["proto-output"];
  const modules: Modules = {
    compiler: guest.bytes,
    generators: { cpp: guest.bytes },
  };
  const job = { request: new Uint8Array(1), generators: ["cpp"] as const };
  const direct = await (await createCompiler(modules)).generate(job);
  const worker = await createWorkerCompiler(workerURL, modules);
  try {
    const threaded = await worker.generate(job);
    for (
      const [label, result] of [["direct", direct], [
        "worker",
        threaded,
      ]] as const
    ) {
      assert(
        Object.getPrototypeOf(result) === Object.prototype &&
          Object.getPrototypeOf(result.outputs) === Object.prototype &&
          Object.getPrototypeOf(result.outputs.cpp) === Object.prototype &&
          Array.isArray(result.diagnostics),
        `${label} result is not made of plain objects`,
      );
      const files = result.outputs.cpp!;
      assert(
        JSON.stringify(Object.keys(files).sort()) === '["__proto__","a"]' &&
          Object.hasOwn(files, "__proto__") &&
          typeof files.hasOwnProperty === "function" &&
          files.buffer === undefined,
        `${label} lost guest-chosen output names`,
      );
      equalBytes(files["__proto__"], encoder.encode("x"), `${label} __proto__`);
    }
    equalOutputs(threaded, direct);
  } finally {
    worker.dispose();
  }
});

workerTest(
  "SDK worker keeps caller buffers intact when it transfers job copies",
  async () => {
    const { modules, request } = await fixture();
    const expected = await (await createCompiler(modules)).compile(request);
    const worker = await createWorkerCompiler(workerURL, modules);
    try {
      const files: Files = Object.fromEntries(
        Object.entries(request.files).map((
          [path, bytes],
        ) => [path, new Uint8Array(bytes as Uint8Array)]),
      );
      const result = await worker.compile({ ...request, files });
      for (const bytes of Object.values(files)) {
        assert((bytes as Uint8Array).length > 0, "caller input was detached");
      }
      equalOutputs(result, expected);
      assert(
        result.request.length === expected.request.length &&
          Object.values(result.outputs.cpp!).every((bytes) => bytes.length > 0),
        "transferred results arrived detached",
      );
      const saved = new Uint8Array(expected.request);
      const generated = await worker.generate({
        request: saved,
        generators: ["rust"],
      });
      assert(saved.length > 0, "caller request was detached");
      equalOutputs(generated, { outputs: { rust: expected.outputs.rust } });
    } finally {
      worker.dispose();
    }
  },
);

workerTest(
  "SDK worker reports script load and initialization failures",
  async () => {
    const modules: Modules = { compiler: trapGuest, generators: {} };
    await countingWorkers(async (constructions) => {
      const missing = new URL("./missing-worker.js", import.meta.url);
      // Deno 2.6.8 reports an unresolvable worker module as a type-check failure;
      // newer releases name the missing module. Either is the ErrorEvent text.
      const loadFailure = await rejectsWith(
        () => createWorkerCompiler(missing, modules),
        Error,
      );
      assert(
        /missing-worker\.js|Type checking failed/.test(loadFailure.message),
        `load failure lost its reason: ${loadFailure.message}`,
      );
      assert(constructions() === 1, "load failure did not create one worker");
      // The engine refuses these bytes inside the worker; the factory rejects
      // with the direct TypeError and terminates the useless worker.
      const refused = await rejectsWith(
        () =>
          createWorkerCompiler(workerURL, {
            compiler: commandGuest([0x0c, 5]),
            generators: {},
          }),
        TypeError,
      );
      assert(
        refused.message.startsWith("the engine rejected the Wasm module") &&
          (refused.cause as Error)?.name === "CompileError",
        `init failure lost its cause: ${refused.message}`,
      );
      assert(constructions() === 2, "init failure did not create one worker");
    });
    await rejectsWith(
      () => createWorkerCompiler("./relative-worker.js", modules),
      TypeError,
    );
  },
);

workerTest(
  "SDK worker initialization honours signal and initTimeoutMs",
  async () => {
    const { modules } = await fixture();
    await countingWorkers(async (constructions) => {
      await rejects(
        () =>
          createWorkerCompiler(workerURL, modules, {
            signal: AbortSignal.abort(),
          }),
        "AbortError",
      );
      assert(constructions() === 0, "an aborted factory created a worker");
      const controller = new AbortController();
      const pending = createWorkerCompiler(workerURL, modules, {
        signal: controller.signal,
      });
      controller.abort(new Error("cancelled by the test"));
      await rejects(() => pending, "Error", "cancelled by the test");
      await rejects(
        () => createWorkerCompiler(workerURL, modules, { initTimeoutMs: 1 }),
        "TimeoutError",
      );
      for (const initTimeoutMs of [0, -1, NaN, Infinity]) {
        await rejects(
          () => createWorkerCompiler(workerURL, modules, { initTimeoutMs }),
          "TypeError",
          "initTimeoutMs",
        );
      }
    });
  },
);

workerTest(
  "SDK worker dispose interrupts the restart wait and supports using",
  async () => {
    const worker = await createWorkerCompiler(workerURL, {
      compiler: loopGuest,
      generators: {},
    });
    const job: CompileRequest = { ...simpleRequest(), generators: [] };
    await rejects(() => worker.compile(job, { timeoutMs: 20 }), "TimeoutError");
    // The next job waits out the 2.1 s Deno termination grace; disposing must
    // release it immediately instead of after the wait.
    const waiting = worker.compile(job);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [, elapsed] = await timed(async () => {
      worker.dispose();
      await rejects(() => waiting, "Error", "disposed");
    });
    assert(elapsed < 500, `dispose during restart wait took ${elapsed} ms`);
    await rejects(() => worker.compile(job), "Error", "disposed");

    const disposable = await createWorkerCompiler(workerURL, {
      compiler: trapGuest,
      generators: {},
    });
    // Assignable to Disposable, so `using compiler = ...` type-checks.
    const resource: Disposable = disposable;
    assert(
      typeof resource[Symbol.dispose] === "function",
      "worker compiler is not disposable",
    );
    resource[Symbol.dispose]();
    await rejects(() => disposable.compile(job), "Error", "disposed");
  },
);

workerTest(
  "SDK worker client settles jobs whose error replies are malformed",
  async () => {
    // A stand-in worker that answers init, then replies to every job with an
    // error whose cause chain is cyclic and whose fields have the wrong types.
    const source = `self.onmessage = ({ data }) => {
      if (data.kind === "init") {
        self.postMessage({ id: data.id, result: undefined });
        return;
      }
      const cycle = { name: "CycleError", message: "loops" };
      cycle.cause = cycle;
      self.postMessage({
        id: data.id,
        error: { kind: "type", message: 123, cause: cycle },
      });
    };`;
    const url = URL.createObjectURL(
      new Blob([source], { type: "text/javascript" }),
    );
    const job: CompileRequest = { ...simpleRequest(), generators: [] };
    try {
      const worker = await createWorkerCompiler(url, {
        compiler: trapGuest,
        generators: {},
      });
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const error = await rejectsWith(
            () => worker.compile(job),
            TypeError,
            "123",
          );
          let depth = 0;
          let cause: unknown = error.cause;
          while (cause instanceof Error) {
            depth++;
            cause = cause.cause;
          }
          assert(
            depth === 8 && (error.cause as Error).name === "CycleError",
            `attempt ${attempt}: cause chain depth ${depth}`,
          );
        }
      } finally {
        worker.dispose();
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  },
);

workerTest(
  "SDK worker factory ignores unrelated properties on the module set",
  async () => {
    // Only the validated fields are snapshotted, so a non-cloneable extra
    // property is accepted exactly as createCompiler accepts it.
    const decorated = Object.assign({ compiler: trapGuest, generators: {} }, {
      loader() {},
      registry: new WeakMap(),
    });
    const job: CompileRequest = { ...simpleRequest(), generators: [] };
    const direct = await createCompiler(decorated);
    await rejects(() => direct.compile(job), "CompileError", "trapped");
    const worker = await createWorkerCompiler(workerURL, decorated);
    try {
      await rejects(() => worker.compile(job), "CompileError", "trapped");
    } finally {
      worker.dispose();
    }
  },
);

Deno.test("SDK resolves relative worker URLs against the document base", () => {
  const page = { location: { href: "https://app.example/page/index.html" } };
  assert(
    resolveWorkerURL("./worker.js", page).href ===
      "https://app.example/page/worker.js",
    "location fallback",
  );
  const based = {
    ...page,
    document: { baseURI: "https://app.example/assets/" },
  };
  assert(
    resolveWorkerURL("./worker.js", based).href ===
      "https://app.example/assets/worker.js",
    "base href was ignored",
  );
  assert(
    resolveWorkerURL("https://cdn.example/w.js", based).href ===
        "https://cdn.example/w.js" &&
      resolveWorkerURL(new URL("https://cdn.example/w.js"), based).href ===
        "https://cdn.example/w.js",
    "absolute URLs were rewritten",
  );
  let thrown: unknown;
  try {
    resolveWorkerURL("./w.js", {});
  } catch (error) {
    thrown = error;
  }
  assert(
    thrown instanceof TypeError && thrown.message.includes("absolute"),
    `relative URL without a base: ${thrown}`,
  );
});
