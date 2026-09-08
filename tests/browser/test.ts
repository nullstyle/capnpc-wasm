import { chromium } from "playwright";

// This driver deliberately prepares its native oracle before browser execution,
// then revokes its own process/network permissions for the offline SDK tests.
const root = Deno.cwd();
const languages = ["cpp", "rust", "go"] as const;
type Language = typeof languages[number];
type FileMap = Record<string, string | Uint8Array>;
type Input = {
  files: FileMap;
  includeFiles: FileMap;
  entrypoints: string[];
  generators: Language[];
};
type Result = {
  request: Uint8Array;
  outputs: Record<Language, Record<string, Uint8Array>>;
  diagnostics: { stage: string; stderr: string }[];
};
type Compiler = { compile(input: Input): Promise<Result> };
type WorkerCompiler = {
  compile(
    input: Input,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Result>;
  dispose(): void;
};
type Modules = {
  compiler: Uint8Array;
  generators: Record<Language, Uint8Array>;
};
type SDK = {
  createCompiler(modules: Modules): Promise<Compiler>;
  createWorkerCompiler(
    url: string,
    modules: Modules,
  ): Promise<WorkerCompiler>;
};
type BrowserState = {
  direct: Compiler;
  worker: WorkerCompiler;
  workerURL: string;
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
      JSON.stringify([...languages].sort()),
    `${label} omitted generator output`,
  );
  for (const language of languages) {
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
      result[path] = await Deno.readTextFile(`${directory}/${entry.name}`);
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
    prefix: "browser-",
  });
  const source = await files(`${root}/tests/fixtures/schemas`);
  const includes = {
    "capnp/c++.capnp": await Deno.readTextFile(
      `${root}/dist/include/capnp/c++.capnp`,
    ),
    "go.capnp": await Deno.readTextFile(`${root}/dist/include/go.capnp`),
  };
  const scenarios = [];
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
    const directory = `${work}/${name}`;
    await writeFiles(`${directory}/src`, input.files);
    await writeFiles(`${directory}/include`, includes);
    const request = await native([
      `${root}/build/native/bin/capnp`,
      "compile",
      "--no-standard-import",
      `-I${directory}/include`,
      `--src-prefix=${directory}/src`,
      "-o-",
      ...input.entrypoints.map((path) => `${directory}/src/${path}`),
    ], root);
    const expected: Record<string, FileMap> = {};
    for (const language of languages) {
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
    scenarios.push({ name, input, expected });
  }
  return {
    work,
    scenarios,
    invalid: await files(`${root}/tests/fixtures/invalid`),
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
for (const name of ["capnp", "capnpc-c++", "capnpc-rust", "capnpc-go"]) {
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
        "<!doctype html><title>capnp-wasm browser tests</title>",
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
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch();
  console.log(`Testing Chromium ${browser.version()}`);
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(60_000);
  await page.goto(`http://127.0.0.1:${server.addr.port}/`);
  await page.evaluate(async () => {
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
    };
    for (const name of ["Deno", "process", "require"]) {
      if (name in globalThis) {
        throw new Error(`browser exposes native API ${name}`);
      }
    }
  });

  let networkRequests = 0;
  context.on("request", () => networkRequests++);
  await context.route("**/*", (route) => route.abort());
  await context.setOffline(true);
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
      equalOutputs(
        result.outputs,
        scenario.expected,
        `${host} ${scenario.name}`,
      );
      console.log(
        `PASS Chromium ${host}: ${scenario.name} matches native C++/Rust/Go`,
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
        `${host} dropped compiler diagnostics for ${name}`,
      );
      console.log(`PASS Chromium ${host}: ${name} reports compiler failure`);
    }
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
      `PASS Chromium worker: ${mode} terminates the job and permits reuse`,
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
  console.log(
    `Browser suite passed offline with process spawning disabled; fixtures: ${data.work}`,
  );
} finally {
  await browser?.close();
  await server.shutdown();
}
