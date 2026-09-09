import { chromium, firefox, webkit } from "playwright";
import { selectedEngines } from "./engines.ts";

// This driver deliberately prepares its native oracle before browser execution,
// then revokes its own process/network permissions for the offline SDK tests.
const root = Deno.cwd();
if (Deno.args.length < 1 || Deno.args.length > 2 || Deno.args[0] === "all") {
  throw new TypeError(
    "Pass one browser and an optional receipt path; use run.ts for canonical request verification",
  );
}
const engine = selectedEngines(Deno.args.slice(0, 1))[0];
const browserType = { chromium, firefox, webkit }[engine];
const languages = ["cpp", "rust", "go", "zig"] as const;
type Language = typeof languages[number];
type FileMap = Record<string, string | Uint8Array>;
type Input = {
  files: FileMap;
  includeFiles: FileMap;
  entrypoints: string[];
  generators: Language[];
};
type GenerationResult = {
  outputs: Record<Language, Record<string, Uint8Array>>;
  diagnostics: { stage: string; stderr: string }[];
};
type Result = GenerationResult & { request: Uint8Array };
type GenerationInput = { request: Uint8Array; generators: Language[] };
type Compiler = {
  compile(input: Input): Promise<Result>;
  generate(input: GenerationInput): Promise<GenerationResult>;
};
type WorkerCompiler = {
  compile(
    input: Input,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Result>;
  generate(input: GenerationInput): Promise<GenerationResult>;
  dispose(): void;
};
type Modules = {
  compiler: Uint8Array;
  generators: Partial<Record<Language, Uint8Array>>;
};
type Options = {
  limits?: {
    memoryPages?: number;
    workspaceBytes?: number;
    outputBytes?: number;
    stdoutBytes?: number;
  };
};
type SDK = {
  createCompiler(modules: Modules, options?: Options): Promise<Compiler>;
  createWorkerCompiler(
    url: string,
    modules: Modules,
    options?: Options,
  ): Promise<WorkerCompiler>;
};
type BrowserState = {
  direct: Compiler;
  worker: WorkerCompiler;
  workerURL: string;
  sdk: SDK;
  modules: Modules;
  memoryGuest: Uint8Array;
  streamGuest: Uint8Array;
};
type BrowserGlobal = typeof globalThis & { capnpTest: BrowserState };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equalOutputs(
  actual: Record<string, Record<string, number[]>>,
  expected: Record<string, FileMap>,
  label: string,
): void {
  assert(
    JSON.stringify(Object.keys(actual).sort()) ===
      JSON.stringify(Object.keys(expected).sort()),
    `${label} omitted generator output`,
  );
  for (const language of Object.keys(expected)) {
    assert(
      JSON.stringify(Object.keys(actual[language]).sort()) ===
        JSON.stringify(Object.keys(expected[language]).sort()),
      `${label} ${language} filenames differ`,
    );
    for (const [path, content] of Object.entries(expected[language])) {
      const bytes = typeof content === "string"
        ? new TextEncoder().encode(content)
        : content;
      assert(
        actual[language][path].length === bytes.length &&
          bytes.every((value, index) =>
            actual[language][path][index] === value
          ),
        `${label} ${language} ${path} differs from native`,
      );
    }
  }
}

async function native(
  args: string[],
  cwd: string,
  input?: Uint8Array,
): Promise<Uint8Array> {
  const command = new Deno.Command(args[0], {
    args: args.slice(1),
    cwd,
    stdin: input ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(60_000),
  }).spawn();
  const result = command.output();
  if (input) {
    const writer = command.stdin.getWriter();
    await writer.write(input);
    await writer.close();
  }
  const output = await result;
  assert(
    output.success,
    `${args[0]} failed: ${new TextDecoder().decode(output.stderr)}`,
  );
  return output.stdout;
}

async function files(directory: string, prefix = ""): Promise<FileMap> {
  const result: FileMap = {};
  for await (const entry of Deno.readDir(directory)) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory) {
      Object.assign(
        result,
        await files(`${directory}/${entry.name}`, `${path}/`),
      );
    } else {
      assert(entry.isFile, `unsupported fixture entry ${path}`);
      result[path] = await Deno.readFile(`${directory}/${entry.name}`);
    }
  }
  return result;
}

async function writeFiles(directory: string, entries: FileMap): Promise<void> {
  for (const [path, content] of Object.entries(entries)) {
    const target = `${directory}/${path}`;
    await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeFile(
      target,
      typeof content === "string" ? new TextEncoder().encode(content) : content,
    );
  }
}

async function prepare() {
  await Deno.mkdir(`${root}/build/test`, { recursive: true });
  const work = await Deno.makeTempDir({
    dir: `${root}/build/test`,
    prefix: `browser-${engine}-`,
  });
  for (const name of ["memory-limit", "stream-limit"]) {
    await native([
      "wasm-tools",
      "parse",
      `${root}/tests/browser/${name}.wat`,
      "-o",
      `${work}/${name}.wasm`,
    ], root);
  }
  const source = await files(`${root}/tests/fixtures/schemas`);
  const includes = {
    "capnp/c++.capnp": await Deno.readTextFile(
      `${root}/dist/include/capnp/c++.capnp`,
    ),
    "go.capnp": await Deno.readTextFile(`${root}/dist/include/go.capnp`),
    "capnp/stream.capnp": await Deno.readFile(
      `${root}/dist/include/capnp/stream.capnp`,
    ),
  };
  const inputs: { name: string; input: Input }[] = [];
  for (const name of ["person.capnp", "pérson.capnp"]) {
    const input: Input = {
      files: {
        [name]: source["person.capnp"],
        "types/common.capnp": source["types/common.capnp"],
      },
      includeFiles: includes,
      entrypoints: [name, "types/common.capnp"],
      generators: [...languages],
    };
    inputs.push({ name, input });
  }
  const featureRoot = `${root}/tests/fixtures/features`;
  const manifest = JSON.parse(
    await Deno.readTextFile(`${featureRoot}/manifest.json`),
  ) as {
    files: string[];
    scenarios: {
      name: string;
      entrypoints: string[];
      generators: Language[];
    }[];
  };
  const featureFiles: FileMap = {};
  for (const path of manifest.files) {
    featureFiles[path] = await Deno.readFile(
      `${featureRoot}/workspace/${path}`,
    );
  }
  for (const scenario of manifest.scenarios) {
    inputs.push({
      name: `features-${scenario.name}`,
      input: {
        files: featureFiles,
        includeFiles: includes,
        entrypoints: scenario.entrypoints,
        generators: scenario.generators,
      },
    });
  }
  for (
    const [name, entrypoints] of [
      ["generic-rpc", ["generic_rpc.capnp", "generic_rpc_external.capnp"]],
      ["streaming-rpc", ["streaming.capnp"]],
    ] as const
  ) {
    const rpcFiles: FileMap = {};
    for (const path of entrypoints) {
      rpcFiles[path] = await Deno.readFile(
        `${root}/tests/rpc_codegen/schemas/${path}`,
      );
    }
    inputs.push({
      name,
      input: {
        files: rpcFiles,
        includeFiles: includes,
        entrypoints: [...entrypoints],
        generators: ["zig"],
      },
    });
  }
  const scenarios = [];
  for (const { name, input } of inputs) {
    const directory = `${work}/${name}`;
    await writeFiles(`${directory}/src`, input.files);
    await writeFiles(`${directory}/include`, input.includeFiles);
    const request = await native([
      `${root}/build/native/bin/capnp`,
      "compile",
      "--no-standard-import",
      `-I${directory}/include`,
      `--src-prefix=${directory}/src`,
      "-o-",
      ...input.entrypoints.map((path) => `${directory}/src/${path}`),
    ], root);
    await Deno.writeFile(`${directory}/native-request.bin`, request);
    const canonicalPath = `${directory}/native-canonical.bin`;
    await Deno.writeFile(
      canonicalPath,
      await native(
        [`${root}/build/native/bin/normalize-request`],
        root,
        request,
      ),
    );
    const expected: Record<string, FileMap> = {};
    for (const language of input.generators) {
      const output = `${directory}/${language}`;
      await Deno.mkdir(output);
      const generator = language === "cpp" ? "c++" : language;
      await native(
        [`${root}/build/native/bin/capnpc-${generator}`],
        output,
        request,
      );
      expected[language] = await files(output);
    }
    scenarios.push({
      name,
      input,
      request,
      expected,
      directory,
      canonicalPath,
    });
  }
  return {
    work,
    scenarios,
    invalid: await files(`${root}/tests/fixtures/invalid`),
    memoryGuest: await Deno.readFile(`${work}/memory-limit.wasm`),
    streamGuest: await Deno.readFile(`${work}/stream-limit.wasm`),
  };
}

const data = await prepare();
// Keep Playwright's transient browser profile and artifacts in this test tree.
await Deno.mkdir(`${data.work}/tmp`);
Deno.env.set("TMPDIR", `${data.work}/tmp`);
const assets = new Map<string, { bytes: Uint8Array; type: string }>();
for (const name of ["mod", "worker"]) {
  assets.set(`/sdk/${name}.js`, {
    bytes: await Deno.readFile(`${root}/dist/typescript/${name}.js`),
    type: "text/javascript",
  });
}
for (
  const name of [
    "capnp",
    "capnpc-c++",
    "capnpc-rust",
    "capnpc-go",
    "capnpc-zig",
  ]
) {
  assets.set(`/wasm/${name}.wasm`, {
    bytes: await Deno.readFile(`${root}/dist/wasm/${name}.wasm`),
    type: "application/wasm",
  });
}
const server = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen() {} },
  (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/") {
      return new Response(
        "<!doctype html><title>capnpc-wasm browser tests</title>",
        {
          headers: { "Content-Type": "text/html" },
        },
      );
    }
    const asset = assets.get(decodeURIComponent(path));
    return asset
      ? new Response(asset.bytes.slice(), {
        headers: { "Content-Type": asset.type },
      })
      : new Response("Not found", { status: 404 });
  },
);
let browser: Awaited<ReturnType<typeof browserType.launch>> | undefined;
try {
  browser = await browserType.launch();
  console.log(`Testing ${engine} ${browser.version()}`);
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(60_000);
  await page.goto(`http://127.0.0.1:${server.addr.port}/`);
  await page.evaluate(async ({ memoryGuest, streamGuest }) => {
    const sdk = await import(new URL("/sdk/mod.js", location.href).href) as SDK;
    const read = async (name: string) => {
      const response = await fetch(`/wasm/${name}.wasm`);
      if (!response.ok) throw new Error(`failed to load ${name}`);
      return new Uint8Array(await response.arrayBuffer());
    };
    const modules: Modules = {
      compiler: await read("capnp"),
      generators: {
        cpp: await read("capnpc-c++"),
        rust: await read("capnpc-rust"),
        go: await read("capnpc-go"),
        zig: await read("capnpc-zig"),
      },
    };
    const workerSource = await (await fetch("/sdk/worker.js")).text();
    const workerURL = URL.createObjectURL(
      new Blob([workerSource], {
        type: "text/javascript",
      }),
    );
    (globalThis as BrowserGlobal).capnpTest = {
      direct: await sdk.createCompiler(modules),
      worker: await sdk.createWorkerCompiler(workerURL, modules),
      workerURL,
      sdk,
      modules,
      memoryGuest,
      streamGuest,
    };
    for (const name of ["Deno", "process", "require"]) {
      if (name in globalThis) {
        throw new Error(`browser exposes native API ${name}`);
      }
    }
  }, { memoryGuest: data.memoryGuest, streamGuest: data.streamGuest });

  let networkRequests = 0;
  context.on("request", (request) => {
    if (!request.url().startsWith("blob:")) networkRequests++;
  });
  await context.route(
    "**/*",
    (route) =>
      route.request().url().startsWith("blob:")
        ? route.continue()
        : route.abort(),
  );
  await context.routeWebSocket("**/*", (socket) => {
    networkRequests++;
    socket.close();
  });
  // WebKit's offline emulation also blocks its local Blob worker reloads.
  // Routing still blocks all network access; Blob URLs read preloaded memory.
  if (engine !== "webkit") await context.setOffline(true);
  await server.shutdown();
  await Deno.permissions.revoke({ name: "run" });
  await Deno.permissions.revoke({ name: "net" });
  assert(
    (await Deno.permissions.query({ name: "run" })).state !== "granted",
    "process permission was not revoked",
  );
  assert(
    (await Deno.permissions.query({ name: "net" })).state !== "granted",
    "network permission was not revoked",
  );

  for (const host of ["direct", "worker"] as const) {
    for (const scenario of data.scenarios) {
      const result = await page.evaluate(async ({ host, input }) => {
        const result = await (globalThis as BrowserGlobal).capnpTest[host]
          .compile(input);
        return {
          request: Array.from(result.request),
          outputs: Object.fromEntries(
            Object.entries(result.outputs).map(([language, files]) => [
              language,
              Object.fromEntries(
                Object.entries(files).map((
                  [path, bytes],
                ) => [path, Array.from(bytes)]),
              ),
            ]),
          ),
          diagnostics: result.diagnostics,
        };
      }, { host, input: scenario.input });
      assert(result.request.length > 0, `${host} produced no request`);
      // The isolated driver never regains process permission. Its parent audits
      // these bytes with the independent native canonicalizer after it exits.
      await Deno.writeFile(
        `${scenario.directory}/${host}-request.bin`,
        new Uint8Array(result.request),
      );
      equalOutputs(
        result.outputs,
        scenario.expected,
        `${host} ${scenario.name}`,
      );
      console.log(
        `PASS ${engine} ${host}: ${scenario.name} matches native ${
          scenario.input.generators.join("/")
        }`,
      );

      const replayed = await page.evaluate(
        async ({ host, request, generators }) => {
          const result = await (globalThis as BrowserGlobal).capnpTest[host]
            .generate({ request, generators });
          return Object.fromEntries(
            Object.entries(result.outputs).map(([language, files]) => [
              language,
              Object.fromEntries(
                Object.entries(files).map((
                  [path, bytes],
                ) => [path, Array.from(bytes)]),
              ),
            ]),
          );
        },
        {
          host,
          request: scenario.request,
          generators: scenario.input.generators,
        },
      );
      equalOutputs(
        replayed,
        scenario.expected,
        `${host} replay ${scenario.name}`,
      );
      console.log(
        `PASS ${engine} ${host}: saved ${scenario.name} request matches native ${
          scenario.input.generators.join("/")
        }`,
      );
    }

    for (const [name, source] of Object.entries(data.invalid)) {
      const failure = await page.evaluate(async ({ host, name, source }) => {
        try {
          await (globalThis as BrowserGlobal).capnpTest[host].compile({
            files: { [name]: source },
            includeFiles: {},
            entrypoints: [name],
            generators: ["cpp"],
          });
          return null;
        } catch (error) {
          const failure = error as Error & {
            stage?: string;
            diagnostics?: { stage: string; stderr: string }[];
          };
          return {
            message: failure.message,
            stage: failure.stage,
            diagnostics: failure.diagnostics,
          };
        }
      }, { host, name, source });
      assert(
        failure && failure.message.length > 0,
        `${host} accepted invalid schema ${name}`,
      );
      assert(
        failure.stage === "compiler" &&
          failure.diagnostics?.some((item) =>
            item.stage === "compiler" && item.stderr.length > 0
          ),
        `${host} dropped compiler diagnostics for ${name}: ${
          JSON.stringify(failure)
        }`,
      );
      console.log(`PASS ${engine} ${host}: ${name} reports compiler failure`);
    }

    for (
      const [name, request] of [
        ["invalid segment table", new Uint8Array([255, 255, 255, 255])],
        ["truncated", data.scenarios[0].request.slice(0, -1)],
      ] as const
    ) {
      const failure = await page.evaluate(async ({ host, request }) => {
        try {
          await (globalThis as BrowserGlobal).capnpTest[host].generate({
            request,
            generators: ["zig"],
          });
          return null;
        } catch (error) {
          const failure = error as Error & {
            stage?: string;
            exitCode?: number;
            diagnostics?: { stage: string; stderr: string }[];
          };
          return {
            stage: failure.stage,
            exitCode: failure.exitCode,
            diagnostics: failure.diagnostics,
            hasOutputs: "outputs" in failure,
          };
        }
      }, { host, request });
      assert(
        failure?.stage === "zig" &&
          typeof failure.exitCode === "number" && failure.exitCode !== 0 &&
          failure.diagnostics?.some((item) =>
            item.stage === "zig" && item.stderr.length > 0
          ) && !failure.hasOutputs,
        `${host} did not preserve Zig ${name} failure: ${
          JSON.stringify(failure)
        }`,
      );
      console.log(
        `PASS ${engine} ${host}: Zig rejects ${name} request without outputs`,
      );
    }
  }

  for (const host of ["direct", "worker"] as const) {
    const evidence = await page.evaluate(async ({ host, input, request }) => {
      const state = (globalThis as BrowserGlobal).capnpTest;
      const create = (modules: Modules, options: Options) =>
        host === "direct"
          ? state.sdk.createCompiler(modules, options)
          : state.sdk.createWorkerCompiler(state.workerURL, modules, options);
      const close = (compiler: Compiler | WorkerCompiler) => {
        if ("dispose" in compiler) compiler.dispose();
      };
      const rejected = async (run: () => Promise<unknown>) => {
        try {
          await run();
          return null;
        } catch (error) {
          return {
            name: (error as Error).name,
            message: (error as Error).message,
            hasOutputs: "outputs" in (error as object),
          };
        }
      };
      const workspace = await create(state.modules, {
        limits: { workspaceBytes: 0 },
      });
      let workspaceFailure;
      try {
        workspaceFailure = await rejected(() => workspace.compile(input));
        await workspace.generate({ request, generators: ["zig"] });
      } finally {
        close(workspace);
      }
      const output = await create(state.modules, {
        limits: { outputBytes: 0 },
      });
      let outputFailure;
      try {
        outputFailure = await rejected(() =>
          output.generate({ request, generators: ["zig"] })
        );
        await output.compile({ ...input, generators: [] });
      } finally {
        close(output);
      }
      const memory = await create({
        compiler: state.memoryGuest,
        generators: {},
      }, { limits: { memoryPages: 2 } });
      try {
        const result = await memory.compile({
          files: { "unused.capnp": "" },
          includeFiles: {},
          entrypoints: ["unused.capnp"],
          generators: [],
        });
        const stream = await create({
          compiler: state.streamGuest,
          generators: {},
        }, { limits: { stdoutBytes: 6 } });
        try {
          const streamFailure = await rejected(() =>
            stream.compile({
              files: { "unused.capnp": "" },
              includeFiles: {},
              entrypoints: ["unused.capnp"],
              generators: [],
            })
          );
          return {
            workspaceFailure,
            outputFailure,
            streamFailure,
            memory: [...result.request],
          };
        } finally {
          close(stream);
        }
      } finally {
        close(memory);
      }
    }, {
      host,
      input: data.scenarios[0].input,
      request: data.scenarios[0].request,
    });
    assert(
      evidence.workspaceFailure?.name === "TypeError" &&
        evidence.workspaceFailure.message.includes("workspaceBytes") &&
        !evidence.workspaceFailure.hasOutputs,
      `${host} did not enforce its workspace limit`,
    );
    assert(
      evidence.outputFailure?.name === "CompileError" &&
        evidence.outputFailure.message.includes("outputBytes") &&
        !evidence.outputFailure.hasOutputs,
      `${host} exposed output from a resource-limited job`,
    );
    assert(
      JSON.stringify(evidence.memory) === "[2]",
      `${host} guest exceeded its two-page linear-memory ceiling`,
    );
    assert(
      evidence.streamFailure?.name === "CompileError" &&
        evidence.streamFailure.message.includes("stdoutBytes") &&
        !evidence.streamFailure.hasOutputs,
      `${host} in-place buffer growth bypassed its stdout limit`,
    );
    console.log(
      `PASS ${engine} ${host}: workspace/output/stream limits, recovery, and guest memory ceiling`,
    );
  }

  for (const mode of ["abort", "timeout"] as const) {
    const result = await page.evaluate(async ({ mode, input }) => {
      const worker = (globalThis as BrowserGlobal).capnpTest.worker;
      const controller = new AbortController();
      let pending: Promise<Result>;
      if (mode === "abort") {
        pending = worker.compile(input, { signal: controller.signal });
        setTimeout(() => controller.abort(), 1);
      } else {
        pending = worker.compile(input, { timeoutMs: 1 });
      }
      try {
        await pending;
        return { name: "unexpected success", outputs: {} };
      } catch (error) {
        const result = await worker.compile(input);
        return {
          name: (error as Error).name,
          outputs: Object.fromEntries(
            Object.entries(result.outputs).map(([language, files]) => [
              language,
              Object.fromEntries(
                Object.entries(files).map((
                  [path, bytes],
                ) => [path, Array.from(bytes)]),
              ),
            ]),
          ),
        };
      }
    }, { mode, input: data.scenarios[0].input });
    assert(
      result.name === (mode === "abort" ? "AbortError" : "TimeoutError"),
      `${mode} failed with ${result.name}`,
    );
    equalOutputs(
      result.outputs,
      data.scenarios[0].expected,
      `worker recovery after ${mode}`,
    );
    console.log(
      `PASS ${engine} worker: ${mode} terminates the job and permits reuse`,
    );
  }

  assert(
    networkRequests === 0,
    `SDK attempted ${networkRequests} network requests after loading`,
  );
  assert(errors.length === 0, `uncaught browser errors: ${errors.join("; ")}`);
  await page.evaluate(() => {
    const state = (globalThis as BrowserGlobal).capnpTest;
    state.worker.dispose();
    URL.revokeObjectURL(state.workerURL);
  });
  const receiptPath = Deno.args[1] ?? `${data.work}/requests.json`;
  await Deno.writeTextFile(
    receiptPath,
    JSON.stringify(
      {
        engine,
        scenarios: data.scenarios.map((scenario) => ({
          name: scenario.name,
          canonicalPath: scenario.canonicalPath,
          requests: ["direct", "worker"].map((host) => ({
            host,
            path: `${scenario.directory}/${host}-request.bin`,
          })),
        })),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `${engine} execution passed offline with process spawning disabled; canonical audit receipt: ${receiptPath}`,
  );
} finally {
  await browser?.close();
  await server.shutdown();
}
