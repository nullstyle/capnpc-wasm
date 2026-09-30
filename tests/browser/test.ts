import { chromium, firefox, webkit } from "./playwright.ts";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import { Buffer } from "node:buffer";
import { selectedEngines } from "./engines.ts";
import { hostileGuests } from "../../sdk/typescript/testdata/hostile_guests.ts";
import { interruptGuests } from "../../sdk/typescript/testdata/interrupt_guests.ts";
import { instrument } from "../../sdk/typescript/rewriter.ts";
import { defaultLimits } from "../../sdk/typescript/types.ts";
import type {
  CompileError,
  Compiler,
  CompileRequest,
  CompileResult,
  CompilerOptions,
  Language,
  Modules,
  WorkerCompiler,
} from "./sdk.ts";
import { envMilliseconds, stepClock } from "./deadline.ts";
import { scaled } from "../lib/timeout-scale.ts";
import {
  type EngineHealth,
  engineHealthScript,
  judgeStall,
  type PageTracer,
  type StallEvidence,
  workerTracerScript,
} from "./worker-trace.ts";
import {
  recordStall,
  type SoakStall,
  stallBudget,
  stallJob,
  stallLedgerPath,
  stallPlace,
  type StallStep,
  stallTitle,
} from "./soak-stalls.ts";
import {
  parseWorkerStallDrill,
  type StallRuleHost,
  underStallRule,
} from "./stall-rule.ts";
import { describeObservation } from "../conformance/outcome.ts";
import {
  closedTargetError,
  crashFailure,
  crashObservation,
  type EngineCrash,
  latestCrashReport,
  summarizeCrashReport,
  TraceMirror,
} from "./engine-crash.ts";
import {
  type BrowserRow,
  browserSurfaces,
  bundleStudioAdapter,
  loadBrowserCorpus,
  runBrowserSurface,
  setupConformance,
  teardownConformance,
} from "./conformance.ts";
import {
  checkIsolatedTermination,
  checkPlainTermination,
  describeStall,
  isolationHeaders,
  setupTermination,
  type TerminationResult,
  type TolerateStall,
  workerAuditScript,
} from "./termination.ts";

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
type FileMap = Record<string, string | Uint8Array>;
/** A complete compile request: every scenario names its includes and generators. */
type Input = CompileRequest & { includeFiles: FileMap; generators: Language[] };
type Result = CompileResult;
type SDK = {
  CompileError: new (...args: never[]) => CompileError;
  createCompiler(
    modules: Modules,
    options?: CompilerOptions,
  ): Promise<Compiler>;
  createWorkerCompiler(
    url: string,
    modules: Modules,
    options?: CompilerOptions,
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
  hostileGuests?: Record<string, Uint8Array>;
  /** The recovery soak's client: the real compiler and a spinning zig generator. */
  soak?: WorkerCompiler;
};

/**
 * A soak recovery that did not finish, as the page reports it: the evidence
 * judgeStall() reads, and the retry the page made on the same client.
 */
type SoakStallRecord = StallEvidence & {
  afterMs: number;
  /** Whether the client had terminated the stalled worker. */
  terminated: boolean | null;
  /** Traced workers before the health checks, which start their own. */
  workersStarted: number;
  retry: {
    ok: boolean;
    ms: number;
    error: string | null;
    /** The workers the retry started, or the stalled one if it reused it. */
    workers: string[][];
  };
};
type BrowserGlobal = typeof globalThis & {
  capnpTest: BrowserState;
  /** Every worker the main page created, traced (worker-trace.ts). */
  capnpTracer: PageTracer;
};
type HostileOutcome = {
  request?: number[];
  // Entries, not an object: Playwright's result transport cannot carry an own
  // "__proto__" key (WebKit drops it; Deno refuses the prototype assignment).
  outputs?: [string, number[]][];
  plain?: boolean;
  error?: {
    name: string;
    message: string;
    isCompileError: boolean;
    hasOutputs: boolean;
    hasCause: boolean;
  };
  elapsed: number;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Every browser step runs under a labelled deadline (TST-07), 60 seconds by
// default (CAPNP_BROWSER_DEADLINE_MS), so a stalled engine fails with the
// step's label instead of holding the job until the CI timeout. The default,
// the pages' Playwright timeouts, and the close steps scale together by
// CAPNP_TEST_TIMEOUT_SCALE (tests/lib/timeout-scale.ts); an explicit
// CAPNP_BROWSER_DEADLINE_MS is used as given, and the SDK bounds inside the
// page (termination, soak, resource limits) keep their calibrated values.
// CAPNP_BROWSER_STALL=<text> makes the first step whose label contains the
// text hang, which demonstrates the deadline. The running step's label is kept
// next to the receipt for run.ts, which reports it if it has to stop a driver.
const receiptPath = Deno.args[1];
const stepPath = receiptPath ? `${receiptPath}.step` : undefined;
/** Once a step fails, cleanup steps no longer replace its label. */
let failedStep: string | undefined;
function recordStep(label: string) {
  if (!stepPath) return;
  try {
    Deno.writeTextFileSync(stepPath, `${label}\n`);
  } catch {
    // The step file is a diagnostic; the run does not depend on it.
  }
}
const clock = stepClock({
  defaultMs: envMilliseconds("CAPNP_BROWSER_DEADLINE_MS", scaled(60_000)),
  stall: Deno.env.get("CAPNP_BROWSER_STALL") || undefined,
  onStep(label) {
    if (failedStep === undefined) recordStep(label);
  },
});

/** page.evaluate under a labelled deadline. */
type Evaluate = ReturnType<typeof evaluateOn>;
function evaluateOn(page: Page) {
  return <T, A>(
    fn: (argument: A) => T | Promise<T>,
    argument: A,
    label: string,
    ms?: number,
  ): Promise<T> =>
    // Playwright cannot type a page function over a generic argument.
    // deno-lint-ignore no-explicit-any
    clock.step(page.evaluate(fn as any, argument) as Promise<T>, label, ms);
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

/** Run a native tool that must fail; returns its stderr text. */
async function nativeFailure(args: string[], cwd: string): Promise<string> {
  const output = await new Deno.Command(args[0], {
    args: args.slice(1),
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(60_000),
  }).output();
  assert(!output.success, `${args[0]} unexpectedly succeeded`);
  return new TextDecoder().decode(output.stderr);
}

/** The oracle's normalization: strip staging prefixes, mask ids, drop kj stacks. */
function normalizeDiagnostic(text: string, prefixes: string[] = []): string {
  let result = text;
  for (const prefix of prefixes) result = result.split(prefix).join("");
  return result
    .replace(/@0x[0-9a-f]{16}/g, "@0x<id>")
    .split("\n")
    .filter((line) => !line.startsWith("stack: "))
    .join("\n");
}

// Host or engine failures leaking into guest diagnostics would look like this.
const trapText =
  /wasm trap|wasm error|failed to run main module|^wazero-run:|^deno-wasi-run:|unreachable|terminating due to uncaught|RuntimeError/m;
const hostPath = /\/Users\/|\/home\/|[A-Za-z]:\\/;

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

/** Assemble tests/browser/<name>.wat with the pinned wasm-tools. */
async function assemble(work: string, name: string): Promise<Uint8Array> {
  await native([
    "wasm-tools",
    "parse",
    `${root}/tests/browser/${name}.wat`,
    "-o",
    `${work}/${name}.wasm`,
  ], root);
  return await Deno.readFile(`${work}/${name}.wasm`);
}

async function prepare() {
  await Deno.mkdir(`${root}/build/test`, { recursive: true });
  const work = await Deno.makeTempDir({
    dir: `${root}/build/test`,
    prefix: `browser-${engine}-`,
  });
  const memoryGuest = await assemble(work, "memory-limit");
  const streamGuest = await assemble(work, "stream-limit");
  const spinGuest = await assemble(work, "spin-yield");
  const spinCounter = await assemble(work, "spin-counter");
  // The SDK tests embed these guests because they cannot spawn wasm-tools.
  // Assemble every source here and refuse to run if either copy drifted.
  const hostile: Record<string, Uint8Array> = {};
  await Deno.mkdir(`${work}/guests`);
  for await (const entry of Deno.readDir(`${root}/tests/browser/guests`)) {
    if (!entry.name.endsWith(".wat")) continue;
    const name = entry.name.slice(0, -".wat".length);
    await native([
      "wasm-tools",
      "parse",
      `${root}/tests/browser/guests/${entry.name}`,
      "-o",
      `${work}/guests/${name}.named.wasm`,
    ], root);
    await native([
      "wasm-tools",
      "strip",
      "--all",
      `${work}/guests/${name}.named.wasm`,
      "-o",
      `${work}/guests/${name}.wasm`,
    ], root);
    const bytes = await Deno.readFile(`${work}/guests/${name}.wasm`);
    const embedded = hostileGuests[name];
    assert(
      embedded,
      `tests/browser/guests/${entry.name} has no embedded copy in sdk/typescript/testdata/hostile_guests.ts`,
    );
    assert(
      bytes.length === embedded.bytes.length &&
        bytes.every((byte, index) => byte === embedded.bytes[index]),
      `tests/browser/guests/${entry.name} no longer matches its embedded bytes; regenerate sdk/typescript/testdata/hostile_guests.ts`,
    );
    hostile[name] = bytes;
  }
  for (const name of Object.keys(hostileGuests)) {
    assert(name in hostile, `embedded guest ${name} has no .wat source`);
  }
  // The same for the interruption guests in guests/interrupt; named-trap
  // keeps the name section `wasm-tools parse` emits.
  const interruptDirectory = `${root}/tests/browser/guests/interrupt`;
  const interruptSources = new Set<string>();
  await Deno.mkdir(`${work}/guests/interrupt`);
  for await (const entry of Deno.readDir(interruptDirectory)) {
    if (!entry.name.endsWith(".wat")) continue;
    const name = entry.name.slice(0, -".wat".length);
    const embedded = interruptGuests[name];
    assert(
      embedded,
      `tests/browser/guests/interrupt/${entry.name} has no embedded copy in sdk/typescript/testdata/interrupt_guests.ts`,
    );
    const assembled = `${work}/guests/interrupt/${name}.wasm`;
    const parsed = embedded.keepNames ? assembled : `${assembled}.named`;
    await native([
      "wasm-tools",
      "parse",
      `${interruptDirectory}/${entry.name}`,
      "-o",
      parsed,
    ], root);
    if (!embedded.keepNames) {
      await native(
        ["wasm-tools", "strip", "--all", parsed, "-o", assembled],
        root,
      );
    }
    const bytes = await Deno.readFile(assembled);
    assert(
      bytes.length === embedded.bytes.length &&
        bytes.every((byte, index) => byte === embedded.bytes[index]),
      `tests/browser/guests/interrupt/${entry.name} no longer matches its embedded bytes; regenerate sdk/typescript/testdata/interrupt_guests.ts`,
    );
    interruptSources.add(name);
  }
  for (const name of Object.keys(interruptGuests)) {
    assert(
      interruptSources.has(name),
      `embedded interruption guest ${name} has no .wat source`,
    );
  }
  // Every shipped module stays valid after the SDK's interruption rewrite by
  // the pinned wasm-tools too, not only by the engines under test.
  await Deno.mkdir(`${work}/instrumented`);
  for await (const entry of Deno.readDir(`${root}/dist/wasm`)) {
    if (!entry.name.endsWith(".wasm")) continue;
    const instrumented = `${work}/instrumented/${entry.name}`;
    await Deno.writeFile(
      instrumented,
      instrument(
        await Deno.readFile(`${root}/dist/wasm/${entry.name}`),
        defaultLimits.memoryPages,
      ).bytes,
    );
    await native(["wasm-tools", "validate", instrumented], root);
  }
  // The failure and limit corpus, and the Schema Studio adapter bundled with
  // the pinned Deno for the Studio rows.
  const corpus = await loadBrowserCorpus(new URL(`file://${root}/`));
  await bundleStudioAdapter(root, `${work}/studio-adapter.js`);
  // Native diagnostics for the invalid fixtures, staged like the SDK's /src,
  // so both browser modes can be held to the native compiler's exact text.
  const invalid = await files(`${root}/tests/fixtures/invalid`);
  const invalidDirectory = `${work}/invalid`;
  await writeFiles(`${invalidDirectory}/src`, invalid);
  await Deno.mkdir(`${invalidDirectory}/include`);
  const invalidNative: Record<string, string> = {};
  for (const name of Object.keys(invalid)) {
    invalidNative[name] = normalizeDiagnostic(
      await nativeFailure([
        `${root}/build/native/bin/capnp`,
        "compile",
        "--no-standard-import",
        `-I${invalidDirectory}/include`,
        `--src-prefix=${invalidDirectory}/src`,
        "-o-",
        `${invalidDirectory}/src/${name}`,
      ], root),
      [invalidDirectory],
    );
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
    invalid,
    invalidNative,
    memoryGuest,
    streamGuest,
    spinGuest,
    spinCounter,
    hostileGuests: hostile,
    corpus,
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
  const bytes = await Deno.readFile(`${root}/dist/wasm/${name}.wasm`);
  assets.set(`/wasm/${name}.wasm`, { bytes, type: "application/wasm" });
  // The Studio adapter loads the same shipped modules by its own asset paths.
  assets.set(`/studio/assets/wasm/${name}.wasm`, {
    bytes,
    type: "application/wasm",
  });
}
assets.set(
  "/studio/assets/typescript/worker.js",
  assets.get("/sdk/worker.js")!,
);
for (
  const [path, bytes] of Object.entries(await files(`${root}/dist/include`))
) {
  assets.set(`/studio/assets/include/${path}`, {
    bytes: bytes as Uint8Array,
    type: "text/plain",
  });
}
assets.set("/studio/adapter.js", {
  bytes: await Deno.readFile(`${data.work}/studio-adapter.js`),
  type: "text/javascript",
});
assets.set("/conformance/page-runner.js", {
  bytes: await Deno.readFile(`${root}/tests/conformance/page-runner.js`),
  type: "text/javascript",
});
const pageHtml = "<!doctype html><title>capnpc-wasm browser tests</title>";
const server = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen() {} },
  (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/" || path === "/isolated") {
      return new Response(
        pageHtml,
        {
          headers: {
            "Content-Type": "text/html",
            // Cross-origin isolation (COOP and COEP) gives the termination
            // probe its SharedArrayBuffer.
            ...(path === "/isolated" ? isolationHeaders : {}),
          },
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
const origin = `http://127.0.0.1:${server.addr.port}`;
let browser: Browser | undefined;
// Engine crashes (engine-crash.ts): a page that crashed, or a browser that
// disconnected before the driver began to close it. The pages mirror their
// workers' trace events here as they happen, so the trace outlives the page.
let closing = false;
let engineCrash: EngineCrash | undefined;
let soakCycle: number | null = null;
/** The current main page's name, which a fresh page after a stall changes. */
let mainPageName = "main";
const traces = new TraceMirror();
const runStarted = Date.now();
function crashed(event: string, page: string) {
  engineCrash ??= { event, step: clock.current, cycle: soakCycle, page };
}
/** Watch a page for a crash, and receive its workers' trace events. */
async function watchPage(page: Page, name: string) {
  page.on("crash", () => crashed(`the ${name} page crashed`, name));
  await clock.step(
    page.exposeFunction(
      "capnpTraceSink",
      (worker: number, event: string) => traces.record(name, worker, event),
    ),
    `${engine} mirror the ${name} page's worker traces`,
  );
}
// run.ts stops a driver that overruns its engine deadline with SIGTERM: name
// the step it was on and close the browser before exiting.
Deno.addSignalListener("SIGTERM", () => {
  console.error(
    `FAIL ${engine}: stopped from outside during: ${clock.current}`,
  );
  closing = true;
  const shutdown = browser ? browser.close() : Promise.resolve();
  clock.step(shutdown, `${engine} close after SIGTERM`, scaled(10_000))
    .catch(() => {})
    .finally(() => Deno.exit(1));
});
const errors: string[] = [];
try {
  browser = await clock.step(
    browserType.launch({ timeout: scaled(180_000) }),
    `${engine} launch`,
  );
  browser.on("disconnected", () => {
    if (!closing) crashed("the browser disconnected", mainPageName);
  });
  console.log(`Testing ${engine} ${browser.version()}`);
  const opened = browser;
  // The main page, where every step but the termination acceptance runs.
  // The stall rule (stall-rule.ts) may replace it with a fresh page, which
  // replays the steps later ones depend on (prerequisites) and, once the
  // driver has gone offline, loads the page and its assets from memory.
  // Every module worker a main page creates is traced from the start
  // (worker-trace.ts workerTracerScript), and the page has the engine health
  // checks.
  type MainPage = { context: BrowserContext; page: Page; evaluate: Evaluate };
  const serveFromMemory = (route: Route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "blob:") return route.continue();
    if (url.origin === origin && url.pathname === "/") {
      return route.fulfill({ contentType: "text/html", body: pageHtml });
    }
    const asset = url.origin === origin
      ? assets.get(decodeURIComponent(url.pathname))
      : undefined;
    return asset
      ? route.fulfill({
        contentType: asset.type,
        body: Buffer.from(asset.bytes),
      })
      : route.abort();
  };
  let freshPages = 0;
  const openMainPage = async (fromMemory: boolean): Promise<MainPage> => {
    const name = freshPages === 0 ? "main" : `fresh main ${freshPages}`;
    const context = await clock.step(
      opened.newContext({ serviceWorkers: "block" }),
      `${engine} new ${name} context`,
    );
    // The engine health checks and the worker tracer (worker-trace.ts),
    // which the stall evidence reads.
    await clock.step(
      context.addInitScript(engineHealthScript),
      `${engine} install the ${name} page's engine health checks`,
    );
    await clock.step(
      context.addInitScript(workerTracerScript),
      `${engine} install the ${name} page's worker tracer`,
    );
    if (fromMemory) {
      await clock.step(
        context.route("**/*", serveFromMemory),
        `${engine} serve the ${name} page from memory`,
      );
    }
    const page = await clock.step(
      context.newPage(),
      `${engine} new ${name} page`,
    );
    page.on("pageerror", (error) => errors.push(error.message));
    await watchPage(page, name);
    page.setDefaultTimeout(scaled(60_000));
    await clock.step(page.goto(`${origin}/`), `${engine} load ${name} page`);
    return { context, page, evaluate: evaluateOn(page) };
  };
  let main = await openMainPage(false);
  /** Evaluate on the current main page. */
  const evaluate: Evaluate = (fn, argument, label, ms) =>
    main.evaluate(fn, argument, label, ms);
  /** Main-page steps a fresh main page replays, in order. */
  const prerequisites: ((run: Evaluate) => Promise<unknown>)[] = [];
  let offline = false;
  let goOffline: (name: string, each: BrowserContext) => Promise<void> = () =>
    Promise.reject(new Error("the driver has not gone offline yet"));
  const replaceMainPage = async () => {
    const stale = main;
    freshPages++;
    const fresh = await openMainPage(true);
    for (const prerequisite of prerequisites) {
      await prerequisite(fresh.evaluate);
    }
    if (offline) {
      await clock.step(
        fresh.context.unroute("**/*", serveFromMemory),
        `${engine} stop serving the fresh main page from memory`,
      );
      await goOffline(`fresh main ${freshPages}`, fresh.context);
    }
    main = fresh;
    mainPageName = `fresh main ${freshPages}`;
    await clock.step(
      stale.context.close().catch(() => {}),
      `${engine} close the stalled main page`,
      scaled(30_000),
    );
  };

  // Tolerated stalls, of the steps under the stall rule, the soak and the
  // termination acceptance: recorded in this engine's receipt and in the
  // job's ledger, which holds the stall budget (soak-stalls.ts).
  const soakStalls: SoakStall[] = [];
  const soakStallBudget = stallBudget();
  /** Record a stall that points at the engine; `then` says what follows. */
  const tolerate = async (
    stall: SoakStall,
    then = "recovered on retry",
  ): Promise<void> => {
    soakStalls.push(stall);
    const total = await recordStall(stall);
    const what = `${stallTitle(stall).toLowerCase()} in ${stallPlace(stall)}`;
    console.log(
      `OBSERVED ${engine} ${what}, attributed to the engine and ${then}: ${
        JSON.stringify(stall.detail)
      }`,
    );
    assert(
      total <= soakStallBudget,
      `${engine}: stall ${total} of this job, a ${what}, exceeds its budget of ${soakStallBudget} (CAPNP_SOAK_STALL_BUDGET; the ledger ${stallLedgerPath} is cleared by mise run clean:test): ${stall.summary}`,
    );
  };
  // CAPNP_BROWSER_WORKER_STALL arms a drill: the next SDK worker of a
  // matching step never runs its script, or never answers (stall-rule.ts).
  const drills = parseWorkerStallDrill(
    Deno.env.get("CAPNP_BROWSER_WORKER_STALL"),
  );
  const rule: StallRuleHost = {
    evaluate,
    async freshPage(label) {
      try {
        await replaceMainPage();
      } catch (error) {
        throw new Error(
          `${label}: the fresh main page for its retry could not be prepared: ${
            (error as Error).message
          }`,
          { cause: error },
        );
      }
    },
    tolerate: (kind, label, evidence, because) =>
      tolerate({
        job: stallJob(),
        engine,
        os: Deno.build.os,
        kind: kind as StallStep,
        mode: label,
        at: new Date().toISOString(),
        summary: `${evidence.error}; ${because}; the last event: ${
          evidence.events.at(-1) ?? "none"
        }; fresh worker ${evidence.health.plainWorker}, Wasm in a worker ${evidence.health.workerCompile}, Wasm on the page ${evidence.health.pageCompile}`,
        detail: evidence,
      }, "retried on a fresh page"),
    async beforeAttempt(label) {
      const drill = drills.find((entry) =>
        entry.remaining > 0 && label.includes(entry.text)
      );
      if (!drill) return;
      drill.remaining--;
      await evaluate(
        (mode) => {
          (globalThis as BrowserGlobal).capnpTracer.drill = {
            mode,
            remaining: 1,
          };
        },
        drill.mode,
        `${label}: arm the worker stall drill (${drill.mode})`,
      );
    },
    async afterAttempt(label) {
      if (drills.length === 0) return;
      await evaluate(
        () => {
          const tracer = (globalThis as BrowserGlobal).capnpTracer;
          if (tracer) tracer.drill = null;
        },
        undefined,
        `${label}: disarm the worker stall drill`,
      ).catch(() => {});
    },
  };
  /** Run a step that creates or first uses SDK workers under the stall rule. */
  const stepRule = <T>(
    kind: StallStep,
    label: string,
    attempt: () => Promise<T>,
    classify?: (result: T) => string | null,
  ) => underStallRule(rule, kind, label, attempt, classify);

  const loadSdk = (run: Evaluate) =>
    run(
      async ({ memoryGuest, streamGuest }) => {
        const sdk = await import(
          new URL("/sdk/mod.js", location.href).href
        ) as SDK;
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
      },
      { memoryGuest: data.memoryGuest, streamGuest: data.streamGuest },
      `${engine} load SDK`,
    );

  await stepRule("sdk-client", `${engine} load SDK`, () => loadSdk(evaluate));
  prerequisites.push(loadSdk);
  // The conformance rows import the shared runner and the Studio adapter,
  // and prime the adapter with every language, while the server is up.
  let valid: Uint8Array = new Uint8Array();
  const prepareConformance = async (run: Evaluate) => {
    valid = await setupConformance(
      run,
      data.corpus.guests,
      `${engine} load the conformance runner and the Studio adapter`,
    );
  };
  await stepRule(
    "conformance-setup",
    `${engine} load the conformance runner and the Studio adapter`,
    () => prepareConformance(evaluate),
  );
  prerequisites.push(prepareConformance);

  // The termination acceptance (TST-04) runs a spinning guest on two more
  // pages that audit every Worker the SDK creates and terminates: one
  // cross-origin isolated, whose shared counter shows whether cancellation
  // stopped the guest, and one plain, where the rejection, the terminate()
  // calls, and a follow-up job on the same worker are visible.
  const terminationPages: {
    name: "isolated" | "plain";
    context: BrowserContext;
    page: Page;
  }[] = [];
  for (const name of ["isolated", "plain"] as const) {
    const auditedContext = await clock.step(
      browser.newContext({ serviceWorkers: "block" }),
      `${engine} new ${name} termination context`,
    );
    await clock.step(
      auditedContext.addInitScript(workerAuditScript),
      `${engine} install the ${name} worker audit`,
    );
    await clock.step(
      auditedContext.addInitScript(engineHealthScript),
      `${engine} install the ${name} engine health checks`,
    );
    const auditedPage = await clock.step(
      auditedContext.newPage(),
      `${engine} new ${name} termination page`,
    );
    auditedPage.on("pageerror", (error) => errors.push(error.message));
    await watchPage(auditedPage, name);
    auditedPage.setDefaultTimeout(scaled(60_000));
    await clock.step(
      auditedPage.goto(`${origin}/${name === "isolated" ? "isolated" : ""}`),
      `${engine} load ${name} termination page`,
    );
    const isolation = await setupTermination(
      evaluateOn(auditedPage),
      data.spinGuest,
      data.spinCounter,
      `${engine} prepare ${name} termination page`,
    );
    assert(
      isolation.crossOriginIsolated === (name === "isolated"),
      `${engine} ${name} termination page: crossOriginIsolated is ${isolation.crossOriginIsolated}`,
    );
    terminationPages.push({
      name,
      context: auditedContext,
      page: auditedPage,
    });
  }

  let networkRequests = 0;
  goOffline = async (name, each) => {
    each.on("request", (request) => {
      if (!request.url().startsWith("blob:")) networkRequests++;
    });
    await clock.step(
      each.route(
        "**/*",
        (route) =>
          route.request().url().startsWith("blob:")
            ? route.continue()
            : route.abort(),
      ),
      `${engine} block the ${name} context's network`,
    );
    await clock.step(
      each.routeWebSocket("**/*", (socket) => {
        networkRequests++;
        socket.close();
      }),
      `${engine} block the ${name} context's WebSockets`,
    );
    // WebKit's offline emulation also blocks its local Blob worker reloads.
    // Routing still blocks all network access; Blob URLs read preloaded memory.
    if (engine !== "webkit") {
      await clock.step(
        each.setOffline(true),
        `${engine} take the ${name} context offline`,
      );
    }
  };
  for (
    const [name, each] of [
      ["main", main.context] as const,
      ...terminationPages.map((entry) => [entry.name, entry.context] as const),
    ]
  ) {
    await goOffline(name, each);
  }
  offline = true;
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
      // A worker row runs a job in the page's worker client, the first of
      // which starts its worker: under the stall rule.
      const underRule = <T>(label: string, attempt: () => Promise<T>) =>
        host === "worker"
          ? stepRule("feature-rows", label, attempt)
          : attempt();
      const compileLabel = `${engine} ${host} compile ${scenario.name}`;
      const result = await underRule(compileLabel, () =>
        evaluate(
          async ({ host, input }) => {
            const result = await (globalThis as BrowserGlobal).capnpTest[host]
              .compile(input);
            return {
              request: Array.from(result.request),
              outputs: Object.fromEntries(
                Object.entries(result.outputs).map(([language, files]) => [
                  language,
                  Object.fromEntries(
                    Object.entries(files!).map((
                      [path, bytes],
                    ) => [path, Array.from(bytes)]),
                  ),
                ]),
              ),
              diagnostics: result.diagnostics,
            };
          },
          { host, input: scenario.input },
          compileLabel,
        ));
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

      const replayLabel = `${engine} ${host} replay ${scenario.name}`;
      const replayed = await underRule(replayLabel, () =>
        evaluate(
          async ({ host, request, generators }) => {
            const result = await (globalThis as BrowserGlobal).capnpTest[host]
              .generate({ request, generators });
            return Object.fromEntries(
              Object.entries(result.outputs).map(([language, files]) => [
                language,
                Object.fromEntries(
                  Object.entries(files!).map((
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
          replayLabel,
        ));
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
      const failure = await evaluate(
        async ({ host, name, source }) => {
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
              exitCode?: number;
              diagnostics?: { stage: string; stderr: string }[];
            };
            return {
              message: failure.message,
              stage: failure.stage,
              exitCode: failure.exitCode,
              isCompileError: error instanceof
                (globalThis as BrowserGlobal).capnpTest.sdk.CompileError,
              causeUndefined: failure.cause === undefined,
              hasOutputs: "outputs" in (error as object),
              diagnostics: failure.diagnostics,
            };
          }
        },
        { host, name, source },
        `${engine} ${host} invalid ${name}`,
      );
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
      assert(
        failure.isCompileError && failure.exitCode === 1 &&
          failure.causeUndefined && !failure.hasOutputs &&
          failure.diagnostics!.every((item) => item.stage === "compiler"),
        `${host} ${name} is not a clean compiler exit 1: ${
          JSON.stringify(failure)
        }`,
      );
      const stderr = failure.diagnostics!.map((item) => item.stderr).join("");
      assert(
        !trapText.test(stderr) && !hostPath.test(stderr),
        `${host} ${name} diagnostics leak host or engine text: ${stderr}`,
      );
      assert(
        normalizeDiagnostic(stderr) === data.invalidNative[name],
        `${host} ${name} diagnostics differ from native:\n${
          normalizeDiagnostic(stderr)
        }--- native\n${data.invalidNative[name]}`,
      );
      console.log(
        `PASS ${engine} ${host}: ${name} reports compiler exit 1 with native diagnostics`,
      );
    }

    for (const language of ["cpp", "zig"] as const) {
      for (
        const [name, request] of [
          ["invalid segment table", new Uint8Array([255, 255, 255, 255])],
          ["truncated", data.scenarios[0].request.slice(0, -1)],
          [
            "invalid eight-byte segment table",
            new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0]),
          ],
          ["twelve-byte prefix", data.scenarios[0].request.slice(0, 12)],
        ] as const
      ) {
        const failure = await evaluate(
          async ({ host, request, language }) => {
            try {
              await (globalThis as BrowserGlobal).capnpTest[host].generate({
                request,
                generators: [language],
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
          },
          { host, request, language },
          `${engine} ${host} malformed ${language} request: ${name}`,
        );
        assert(
          failure?.stage === language && failure.exitCode === 1 &&
            failure.diagnostics?.some((item) =>
              item.stage === language && item.stderr.length > 0
            ) && !failure.hasOutputs,
          `${host} did not preserve ${language} ${name} failure: ${
            JSON.stringify(failure)
          }`,
        );
        console.log(
          `PASS ${engine} ${host}: ${language} rejects ${name} request with exit 1 and no outputs`,
        );
      }
    }
  }

  // The resource-limits step starts four compilers (two with every module)
  // and runs six small jobs. In nightly 36141746707 (ubuntu-24.04, three
  // engines at once) a WebKit worker's init ran out of the SDK's 30-second
  // default, while such an init measures about 0.1 s idle and 0.15 s with
  // every core busy (macOS arm64; jobs 16 ms or less): a start stall more
  // than slowness (ledger row 139). The worker step runs under the stall rule
  // (stall-rule.ts), with the SDK's own init and job defaults: whatever times
  // out names itself and its duration in a TimeoutError, which the rule reads.
  // The OBSERVED line keeps every duration.
  for (const host of ["direct", "worker"] as const) {
    const limitsLabel = `${engine} ${host} resource limits`;
    const limits = () =>
      evaluate(
        async ({ host, input, request }) => {
          const state = (globalThis as BrowserGlobal).capnpTest;
          const durations: Record<string, number> = {};
          const timed = async <T>(label: string, run: () => Promise<T>) => {
            const started = performance.now();
            try {
              return await run();
            } catch (error) {
              if ((error as Error).name !== "TimeoutError") throw error;
              throw new DOMException(
                `${label} timed out after ${
                  Math.round(performance.now() - started)
                } ms`,
                "TimeoutError",
              );
            } finally {
              durations[label] = Math.round(performance.now() - started);
            }
          };
          const create = (
            label: string,
            modules: Modules,
            options: CompilerOptions,
          ) =>
            timed(
              `${label} ${host === "direct" ? "creation" : "worker init"}`,
              () =>
                host === "direct"
                  ? state.sdk.createCompiler(modules, options)
                  : state.sdk.createWorkerCompiler(
                    state.workerURL,
                    modules,
                    options,
                  ),
            );
          const close = (compiler: Compiler | WorkerCompiler) => {
            if ("dispose" in compiler) compiler.dispose();
          };
          const rejected = async (
            label: string,
            run: () => Promise<unknown>,
          ) => {
            try {
              await timed(label, run);
              return null;
            } catch (error) {
              // A timeout is a stall for the rule, not the limit's rejection.
              if ((error as Error).name === "TimeoutError") throw error;
              return {
                name: (error as Error).name,
                message: (error as Error).message,
                hasOutputs: "outputs" in (error as object),
              };
            }
          };
          const workspace = await create("workspace-limited", state.modules, {
            limits: { workspaceBytes: 0 },
          });
          let workspaceFailure;
          try {
            workspaceFailure = await rejected(
              "workspace-limited compile",
              () => workspace.compile(input),
            );
            await timed(
              "workspace-limited zig generation",
              () => workspace.generate({ request, generators: ["zig"] }),
            );
          } finally {
            close(workspace);
          }
          const output = await create("output-limited", state.modules, {
            limits: { outputBytes: 0 },
          });
          let outputFailure;
          try {
            outputFailure = await rejected(
              "output-limited zig generation",
              () => output.generate({ request, generators: ["zig"] }),
            );
            await timed(
              "output-limited compile",
              () => output.compile({ ...input, generators: [] }),
            );
          } finally {
            close(output);
          }
          const memory = await create("memory-limited", {
            compiler: state.memoryGuest,
            generators: {},
          }, { limits: { memoryPages: 2 } });
          try {
            const result = await timed(
              "memory-limited compile",
              () =>
                memory.compile({
                  files: { "unused.capnp": "" },
                  includeFiles: {},
                  entrypoints: ["unused.capnp"],
                  generators: [],
                }),
            );
            const stream = await create("stream-limited", {
              compiler: state.streamGuest,
              generators: {},
            }, { limits: { stdoutBytes: 6 } });
            try {
              const streamFailure = await rejected(
                "stream-limited compile",
                () =>
                  stream.compile({
                    files: { "unused.capnp": "" },
                    includeFiles: {},
                    entrypoints: ["unused.capnp"],
                    generators: [],
                  }),
              );
              return {
                workspaceFailure,
                outputFailure,
                streamFailure,
                memory: [...result.request],
                durations,
              };
            } finally {
              close(stream);
            }
          } finally {
            close(memory);
          }
        },
        {
          host,
          input: data.scenarios[0].input,
          request: data.scenarios[0].request,
        },
        limitsLabel,
      );
    const evidence = host === "worker"
      ? await stepRule("resource-limits", limitsLabel, limits)
      : await limits();
    console.log(
      `OBSERVED ${engine} ${host} resource limits: ${
        Object.entries(evidence.durations).map(([label, ms]) =>
          `${label} ${ms} ms`
        ).join(", ")
      }`,
    );
    assert(
      evidence.workspaceFailure?.name === "TypeError" &&
        evidence.workspaceFailure.message.includes("workspaceBytes") &&
        !evidence.workspaceFailure.hasOutputs,
      `${host} did not enforce its workspace limit: ${
        JSON.stringify(evidence.workspaceFailure)
      }`,
    );
    assert(
      evidence.outputFailure?.name === "CompileError" &&
        evidence.outputFailure.message.includes("outputBytes") &&
        !evidence.outputFailure.hasOutputs,
      `${host} exposed output from a resource-limited job: ${
        JSON.stringify(evidence.outputFailure)
      }`,
    );
    assert(
      JSON.stringify(evidence.memory) === "[2]",
      `${host} guest exceeded its two-page linear-memory ceiling`,
    );
    assert(
      evidence.streamFailure?.name === "CompileError" &&
        evidence.streamFailure.message.includes("stdoutBytes") &&
        !evidence.streamFailure.hasOutputs,
      `${host} in-place buffer growth bypassed its stdout limit: ${
        JSON.stringify(evidence.streamFailure)
      }`,
    );
    console.log(
      `PASS ${engine} ${host}: workspace/output/stream limits, recovery, and guest memory ceiling`,
    );
  }

  // Hostile and probing guests: every guest-sized host bound, the read-only
  // workspace, and result shapes must hold in each engine and both modes.
  // The worker step starts a worker per guest, under the stall rule; each
  // guest's elapsed time is its job's, after its compiler exists.
  const loadHostile = (run: Evaluate) =>
    run(
      (guests) => {
        (globalThis as BrowserGlobal).capnpTest.hostileGuests = guests;
      },
      data.hostileGuests,
      `${engine} load hostile guests`,
    );
  await loadHostile(evaluate);
  prerequisites.push(loadHostile);
  for (const host of ["direct", "worker"] as const) {
    const hostileLabel = `${engine} ${host} hostile guests`;
    const hostile = () =>
      evaluate(
        async ({ host, stages }) => {
          const state = (globalThis as BrowserGlobal).capnpTest;
          const outcomes: Record<string, HostileOutcome> = {};
          for (const [name, stage] of Object.entries(stages)) {
            const bytes = state.hostileGuests![name];
            const modules: Modules = {
              compiler: bytes,
              generators: stage === "generator" ? { cpp: bytes } : {},
            };
            const compiler = host === "direct"
              ? await state.sdk.createCompiler(modules)
              : await state.sdk.createWorkerCompiler(state.workerURL, modules);
            const started = performance.now();
            try {
              const result = stage === "compiler"
                ? await compiler.compile({
                  files: { a: "x" },
                  includeFiles: {},
                  entrypoints: ["a"],
                  generators: [],
                })
                : await compiler.generate({
                  request: new Uint8Array(1),
                  generators: ["cpp"],
                });
              const files = result.outputs.cpp as
                | Record<string, Uint8Array>
                | undefined;
              outcomes[name] = {
                request: stage === "compiler"
                  ? Array.from((result as Result).request)
                  : undefined,
                outputs: files
                  ? Object.entries(files).map((
                    [path, data],
                  ) => [path, Array.from(data)] as [string, number[]])
                  : undefined,
                plain: files
                  ? Object.getPrototypeOf(files) === Object.prototype &&
                    Object.getPrototypeOf(result.outputs) ===
                      Object.prototype &&
                    Object.keys(files).every((path) =>
                      Object.hasOwn(files, path)
                    )
                  : undefined,
                elapsed: performance.now() - started,
              };
            } catch (error) {
              // No hostile guest may time out: a timeout is a stall, which the
              // stall rule reads.
              if ((error as Error).name === "TimeoutError") throw error;
              outcomes[name] = {
                error: {
                  name: (error as Error).name,
                  message: (error as Error).message,
                  isCompileError: error instanceof state.sdk.CompileError,
                  hasOutputs: "outputs" in (error as object),
                  hasCause: (error as Error).cause !== undefined,
                },
                elapsed: performance.now() - started,
              };
            } finally {
              // Since both kinds take job options, the conditional's type
              // reduces to Compiler, which declares no dispose.
              if ("dispose" in compiler) (compiler as WorkerCompiler).dispose();
            }
          }
          return outcomes;
        },
        {
          host,
          stages: Object.fromEntries(
            Object.entries(hostileGuests).map(([name, guest]) => [
              name,
              guest.stage,
            ]),
          ),
        },
        hostileLabel,
      );
    const outcomes = host === "worker"
      ? await stepRule("hostile-guests", hostileLabel, hostile)
      : await hostile();
    for (const [name, guest] of Object.entries(hostileGuests)) {
      const outcome = outcomes[name];
      const label = `${host} ${name}`;
      assert(outcome, `${label} produced no outcome`);
      if (guest.expectError) {
        assert(
          outcome.error?.name === guest.expectError.name &&
            (guest.expectError.name !== "CompileError" ||
              outcome.error.isCompileError) &&
            outcome.error.message.includes(guest.expectError.message) &&
            !outcome.error.hasOutputs && outcome.error.hasCause,
          `${label} did not fail as expected: ${JSON.stringify(outcome)}`,
        );
      } else {
        assert(
          !outcome.error,
          `${label} failed: ${JSON.stringify(outcome.error)}`,
        );
        if (guest.expectRequest) {
          assert(
            JSON.stringify(outcome.request) ===
              JSON.stringify(guest.expectRequest),
            `${label} reported ${JSON.stringify(outcome.request)}, expected ${
              JSON.stringify(guest.expectRequest)
            }`,
          );
        }
        if (guest.expectOutputs) {
          const sorted = (entries: [string, number[]][]) =>
            JSON.stringify(
              [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
            );
          assert(
            outcome.plain === true && outcome.outputs &&
              sorted(outcome.outputs) ===
                sorted(Object.entries(guest.expectOutputs)),
            `${label} outputs differ: ${JSON.stringify(outcome)}`,
          );
        }
      }
      assert(
        outcome.elapsed < 1000,
        `${label} took ${outcome.elapsed.toFixed(0)} ms`,
      );
    }
    console.log(
      `PASS ${engine} ${host}: ${
        Object.keys(hostileGuests).length
      } hostile guests are bounded, read-only, and plainly shaped`,
    );
  }

  // Repeated cancellation exposes engine faults that a single one can miss:
  // twenty cycles on one client, alternating an abort and a timeout, each
  // followed by a complete compile on the same client. The client's zig
  // generator spins forever, so the cancelled job, a compile for zig, can never
  // finish first, and both cancellations reach a running guest; the recovery
  // compile then runs the real compiler and the C++, Rust, and Go generators.
  // On this page, which is not cross-origin isolated, an abort replaces the
  // worker and a timeout keeps it. The abort fires at 50 ms, before the job's
  // 2 s deadline.
  //
  // Every soak worker is traced (worker-trace.ts), with the page's posts to it
  // and the replies that reach the page. A recovery gets 20 s, over six times
  // the slowest one measured in CI (WebKit on Linux, 3.1 s). One that does not
  // finish in time is reported with its worker's trace and whether a fresh
  // worker and Wasm compilation still respond, then retried once on the same
  // client, which replaces the stalled worker as it would for an application.
  // judgeStall() decides who the stall points at: a stall that points at the
  // SDK, or a retry that fails too, fails the run, and one that points at the
  // engine counts against the job's stall budget (soak-stalls.ts).
  const soakLanguages = ["cpp", "rust", "go"] as const;
  const soakRecoveryMs = 20_000;
  const soakLabel = `${engine} create the recovery soak client`;
  await stepRule("soak-client", soakLabel, () =>
    evaluate(
      async ({ spinGuest }) => {
        const state = (globalThis as BrowserGlobal).capnpTest;
        state.soak = await state.sdk.createWorkerCompiler(state.workerURL, {
          ...state.modules,
          generators: { ...state.modules.generators, zig: spinGuest },
        });
      },
      { spinGuest: data.spinGuest },
      soakLabel,
    ));
  for (let iteration = 0; iteration < 20; iteration++) {
    soakCycle = iteration + 1;
    const mode = iteration % 2 === 0 ? "abort" : "timeout";
    const result = await evaluate(
      async ({ mode, input, recovered, recoveryMs }) => {
        const state = (globalThis as BrowserGlobal).capnpTest;
        const soak = state.soak!;
        const tracer = (globalThis as BrowserGlobal).capnpTracer;
        const controller = new AbortController();
        const spinning = { ...input, generators: ["zig" as const] };
        let pending: Promise<Result>;
        if (mode === "abort") {
          pending = soak.compile(spinning, {
            signal: controller.signal,
            timeoutMs: 2000,
          });
          setTimeout(() => controller.abort(), 50);
        } else {
          pending = soak.compile(spinning, { timeoutMs: 100 });
        }
        let cancellation: Error | undefined;
        try {
          await pending;
        } catch (error) {
          cancellation = error as Error;
        }
        if (!cancellation) {
          return { name: "unexpected success", outputs: {}, stall: undefined };
        }
        const expectedName = mode === "abort" ? "AbortError" : "TimeoutError";
        if (cancellation.name !== expectedName) {
          throw new Error(
            `${mode} expected ${expectedName}, received ${cancellation.name}: ${cancellation.message}`,
            { cause: cancellation },
          );
        }
        type Recovery =
          | { ok: true; result: Result }
          | { ok: false; error: string; afterMs: number };
        const recover = async (): Promise<Recovery> => {
          const started = performance.now();
          try {
            return {
              ok: true,
              result: await soak.compile({ ...input, generators: recovered }, {
                timeoutMs: recoveryMs,
              }),
            };
          } catch (error) {
            return {
              ok: false,
              error: `${(error as Error).name}: ${(error as Error).message}`,
              afterMs: Math.round(performance.now() - started),
            };
          }
        };
        const postsBefore = tracer.posts.length;
        let recovery = await recover();
        let stall: SoakStallRecord | undefined;
        if (!recovery.ok) {
          // The message the stalled worker had to answer: the page's last
          // post for the recovery, if it posted anything for it at all.
          const post = tracer.posts.slice(postsBefore).at(-1);
          const stalled = post
            ? tracer.workers[post.worker]
            : tracer.workers.at(-1);
          // Counted before the health checks, whose workers are traced too.
          const workersStarted = tracer.workers.length;
          // A copy: the retry below may add to the same worker's events.
          const events = [...(stalled?.events ?? [])];
          // Does the engine itself still start workers and compile Wasm?
          const health = await (globalThis as unknown as {
            capnpEngineHealth(): Promise<EngineHealth>;
          }).capnpEngineHealth();
          // The retry replaces the stalled worker; its trace is the second.
          const before = tracer.workers.length;
          const started = performance.now();
          const retried = await recover();
          stall = {
            expected: post === undefined ? null : post.post,
            error: recovery.error,
            // The whole list: the page keeps at most 60 events per worker.
            events,
            health,
            count: null,
            afterMs: recovery.afterMs,
            terminated: stalled ? stalled.terminated : null,
            workersStarted,
            retry: {
              ok: retried.ok,
              ms: Math.round(performance.now() - started),
              error: retried.ok ? null : retried.error,
              workers: (tracer.workers.length > before
                ? tracer.workers.slice(before)
                : stalled
                ? [stalled]
                : []).map((worker) =>
                  worker.events.slice(-16)
                ),
            },
          };
          if (retried.ok) recovery = retried;
        }
        // The driver judges a stall (judgeStall) before it compares outputs.
        return {
          name: cancellation.name,
          outputs: recovery.ok
            ? Object.fromEntries(
              Object.entries(recovery.result.outputs).map((
                [language, files],
              ) => [
                language,
                Object.fromEntries(
                  Object.entries(files!).map((
                    [path, bytes],
                  ) => [path, Array.from(bytes)]),
                ),
              ]),
            )
            : {},
          stall,
        };
      },
      {
        mode,
        input: data.scenarios[0].input,
        recovered: [...soakLanguages],
        recoveryMs: soakRecoveryMs,
      },
      `${engine} worker ${mode} recovery cycle ${iteration + 1}`,
      3 * soakRecoveryMs + 30_000,
    );
    assert(
      result.name === (mode === "abort" ? "AbortError" : "TimeoutError"),
      `${mode} failed with ${result.name}`,
    );
    const stall = result.stall;
    if (stall) {
      const { suspect, because } = judgeStall(stall);
      assert(
        suspect === "engine",
        `${engine}: soak recovery after ${mode} in cycle ${
          iteration + 1
        } stalled, and the evidence points at the SDK: ${because}; ${
          JSON.stringify(stall)
        }`,
      );
      assert(
        stall.retry.ok,
        `${engine}: soak recovery after ${mode} in cycle ${
          iteration + 1
        } failed twice (${stall.retry.error} after ${stall.retry.ms} ms): ${
          JSON.stringify(stall)
        }`,
      );
    }
    equalOutputs(
      result.outputs,
      Object.fromEntries(
        soakLanguages.map((language) => [
          language,
          data.scenarios[0].expected[language],
        ]),
      ),
      `worker recovery after ${mode}`,
    );
    if (stall) {
      await tolerate({
        job: stallJob(),
        engine,
        os: Deno.build.os,
        cycle: iteration + 1,
        mode,
        at: new Date().toISOString(),
        summary: `${stall.error} after ${stall.afterMs} ms; ${
          judgeStall(stall).because
        }; the last event: ${
          stall.events.at(-1) ?? "none"
        }; fresh worker ${stall.health.plainWorker}, Wasm in a worker ${stall.health.workerCompile}, Wasm on the page ${stall.health.pageCompile}; the retry recovered in ${stall.retry.ms} ms`,
        detail: stall,
      });
    }
    console.log(
      `PASS ${engine} worker: ${mode} rejects the job and permits reuse (${
        iteration + 1
      }/20)`,
    );
  }
  soakCycle = null;
  await evaluate(
    () => {
      const state = (globalThis as BrowserGlobal).capnpTest;
      state.soak!.dispose();
    },
    undefined,
    `${engine} dispose the recovery soak client`,
  );

  // The failure and limit corpus on the three browser surfaces (GAP3-01).
  // Each surface runs its deadline rows last; their timed-out guests stop
  // inside their workers in every engine.
  const conformance: Record<string, { observed: number; skipped: number }> = {};
  const conformanceRows: BrowserRow[] = [];
  for (const surface of browserSurfaces) {
    // The worker and Studio rows start SDK workers: under the stall rule.
    const rows = await runBrowserSurface(
      engine,
      surface,
      data.corpus,
      valid,
      evaluate,
      surface === "browser-direct"
        ? undefined
        : (label, attempt, classify) =>
          stepRule("conformance-rows", label, attempt, classify),
    );
    conformanceRows.push(...rows);
    const skipped = rows.filter((row) => row.skipped).length;
    conformance[surface] = { observed: rows.length - skipped, skipped };
    console.log(
      `PASS ${engine} ${surface}: ${
        rows.length - skipped
      } conformance rows match tests/fixtures/conformance/expected.json (${skipped} not expressible)`,
    );
    // Rows that accept more than one outcome are unmeasured on some host;
    // record what this one produced.
    for (const row of rows) {
      if (row.accepted && row.observation) {
        console.log(
          `OBSERVED ${engine} ${surface} ${row.name}: ${
            describeObservation(row.observation)
          } (accepts ${row.accepted.join(" or ")})`,
        );
      }
    }
  }
  await teardownConformance(evaluate, `${engine} dispose conformance clients`);

  // Termination acceptance, last: a guest that outlived its cancellation would
  // keep a core busy until the browser closed.
  // A probe worker that did not start, where its evidence points at the
  // engine and a retry passed, counts against the same stall budget.
  const tolerateStartStall: TolerateStall = (label, detail) =>
    tolerate({
      job: stallJob(),
      engine,
      os: Deno.build.os,
      kind: "termination",
      mode: label,
      at: new Date().toISOString(),
      summary: describeStall(detail),
      detail,
    });
  const termination: TerminationResult[] = [];
  for (const { name, page: auditedPage } of terminationPages) {
    const result = name === "isolated"
      ? await checkIsolatedTermination(
        engine,
        evaluateOn(auditedPage),
        Deno.build.os,
        tolerateStartStall,
      )
      : await checkPlainTermination(
        engine,
        evaluateOn(auditedPage),
        tolerateStartStall,
      );
    termination.push(result);
    console.log(`OBSERVED ${result.observed}`);
    console.log(result.verdict);
  }

  assert(
    networkRequests === 0,
    `SDK attempted ${networkRequests} network requests after loading`,
  );
  assert(errors.length === 0, `uncaught browser errors: ${errors.join("; ")}`);
  await evaluate(
    () => {
      const state = (globalThis as BrowserGlobal).capnpTest;
      state.worker.dispose();
      URL.revokeObjectURL(state.workerURL);
    },
    undefined,
    `${engine} dispose`,
  );
  const receipt = receiptPath ?? `${data.work}/requests.json`;
  await Deno.writeTextFile(
    receipt,
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
        conformance,
        conformanceRows,
        termination,
        soakStalls,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `${engine} execution passed offline with process spawning disabled; canonical audit receipt: ${receipt}`,
  );
} catch (error) {
  failedStep = clock.current;
  recordStep(failedStep);
  // A page or browser that went away is an engine crash, which the stall
  // budget never covers. Playwright may report the crash just after the call
  // it failed; one it never reports is still the engine's closing the page.
  if (!engineCrash && closedTargetError(error)) {
    for (let wait = 0; wait < 20 && !engineCrash; wait++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    crashed(
      "the page or browser closed without a crash event",
      mainPageName,
    );
  }
  if (engineCrash) {
    failedStep = engineCrash.step;
    recordStep(failedStep);
    // The report is written some seconds after the process died. It is
    // copied next to the receipts, which CI keeps as an artifact.
    const report = await latestCrashReport(engine, runStarted);
    let kept: string | null = null;
    if (report) {
      const directory = receiptPath
        ? receiptPath.slice(0, receiptPath.lastIndexOf("/"))
        : data.work;
      kept = `${directory}/${engine}-${
        report.slice(report.lastIndexOf("/") + 1)
      }`;
      try {
        await Deno.copyFile(report, kept);
        console.log(
          `OBSERVED ${engine} crash report: ${
            summarizeCrashReport(await Deno.readTextFile(report))
          }`,
        );
      } catch (copyError) {
        kept = `${report} (not copied: ${(copyError as Error).message})`;
      }
    }
    console.log(
      crashObservation(
        engine,
        engineCrash,
        traces.last(engineCrash.page),
        kept ?? report,
      ),
    );
    const failure = new Error(crashFailure(engine, engineCrash), {
      cause: error,
    });
    console.error(`FAIL ${failure.message}`);
    throw failure;
  }
  // Report before shutting down an unhealthy browser so cleanup cannot hide
  // the failing operation or the host-side recovery deadline.
  console.error(
    `FAIL ${engine}: ${error instanceof Error ? error.stack : String(error)}`,
  );
  throw error;
} finally {
  // A stalled engine may not close either; bound the wait for it.
  closing = true;
  try {
    await clock.step(
      browser ? browser.close() : Promise.resolve(),
      `${engine} close`,
      scaled(30_000),
    );
  } catch (error) {
    console.error(`FAIL ${engine}: ${(error as Error).message}`);
    Deno.exit(1);
  }
  await server.shutdown();
}
