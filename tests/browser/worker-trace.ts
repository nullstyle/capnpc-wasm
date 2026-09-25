// Evidence for a stalled worker, in the recovery soak (test.ts) and the
// termination acceptance (termination.ts), and the one rule both read it by.
//
// A traced worker is a module worker script (traceWorkerTemplate) that first
// imports the trace module (traceModuleSource, a blob URL substituted for
// __TRACE_URL__) and then the SDK's real worker.js (__REAL_WORKER_URL__).
// Imports evaluate in order, so the trace reports that the worker started and
// listens for messages before worker.js runs; it then reports each message
// the worker receives, each Wasm compile and instantiate, and each reply.
// Tracing only observes; every call goes through unchanged. The page adds its
// own events to the same list: each message it posts to the worker and each
// reply that reaches it. The health script asks whether the engine itself
// still starts a worker and compiles Wasm, in a worker and on the page.

/** What capnpEngineHealth reports: each check's answer and time. */
export interface EngineHealth {
  plainWorker: string;
  workerCompile: string;
  pageCompile: string;
  /** All three answered. */
  healthy: boolean;
}

/**
 * Installed as a page init script: defines capnpEngineHealth(), which starts
 * a plain worker, compiles a module with one empty function in a worker and
 * on the page, and gives each 5 seconds to answer.
 */
export const engineHealthScript = `(() => {
  const within = (ms, promise) =>
    Promise.race([
      promise,
      new Promise((resolve) =>
        setTimeout(() => resolve("no answer in " + ms + " ms"), ms)
      ),
    ]).catch((error) => "error: " + error);
  const blobWorker = (source) =>
    new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
  const timed = async (run) => {
    const started = performance.now();
    const answer = await run();
    return [answer, answer + " after " + Math.round(performance.now() - started) + " ms"];
  };
  const tiny = "0061736d01000000010401600000030201000a040102000b";
  globalThis.capnpEngineHealth = async () => {
    const bytes = Uint8Array.from(tiny.match(/../g), (byte) => parseInt(byte, 16));
    let worker = blobWorker("postMessage('up')");
    const [up, plainWorker] = await timed(() =>
      within(5000, new Promise((resolve) => (worker.onmessage = () => resolve("up"))))
    );
    worker.terminate();
    worker = blobWorker(
      "WebAssembly.compile(new Uint8Array(" + JSON.stringify(Array.from(bytes)) +
        ')).then(() => postMessage("compiled"), (e) => postMessage("error " + e))',
    );
    const [inWorker, workerCompile] = await timed(() =>
      within(5000, new Promise((resolve) => {
        worker.onmessage = (event) => resolve(String(event.data));
      }))
    );
    worker.terminate();
    const [onPage, pageCompile] = await timed(() =>
      within(5000, WebAssembly.compile(bytes).then(() => "compiled"))
    );
    return {
      plainWorker,
      workerCompile,
      pageCompile,
      healthy: up === "up" && inWorker === "compiled" && onPage === "compiled",
    };
  };
})();`;

/** One traced worker, as the page records it. */
export interface TracedWorker {
  /**
   * The worker's `<ms since it started>:<event>` and the page's
   * `page:post:<kind>:<id>` and `page:reply:<id>`, the most recent last.
   */
  events: string[];
  terminated: boolean;
}

/** The trace module: imported before worker.js, so it runs first. */
export const traceModuleSource = `const t0 = performance.now();
const post = self.postMessage.bind(self);
const say = (event) => {
  try { post({ kind: "capnpTrace", event, t: Math.round(performance.now() - t0) }); } catch {}
};
say("started");
self.addEventListener("message", ({ data }) => {
  if (data && data.kind) say("message:" + data.kind + (data.id !== undefined ? ":" + data.id : ""));
});
self.postMessage = (message, transfer) => {
  if (message && message.id !== undefined) say("reply:" + message.id + (message.error ? ":error" : ""));
  return post(message, transfer);
};
let compiles = 0;
const compile = WebAssembly.compile;
WebAssembly.compile = function (bytes) {
  const n = ++compiles;
  say("compile" + n + ":start:" + (bytes && bytes.byteLength));
  return compile.call(WebAssembly, bytes).then(
    (module) => { say("compile" + n + ":end"); return module; },
    (error) => { say("compile" + n + ":error:" + error); throw error; },
  );
};
let instances = 0;
const instantiate = WebAssembly.instantiate;
WebAssembly.instantiate = function (source, imports) {
  const n = ++instances;
  say("instantiate" + n + ":start");
  return instantiate.call(WebAssembly, source, imports).then(
    (result) => { say("instantiate" + n + ":end"); return result; },
    (error) => { say("instantiate" + n + ":error:" + error); throw error; },
  );
};
`;

/** A traced worker script: the trace module's URL and worker.js's substituted in. */
export const traceWorkerTemplate = `import "__TRACE_URL__";
import "__REAL_WORKER_URL__";
`;

/** What the page saw of a worker that did not do what it asked. */
export interface StallEvidence {
  /**
   * The message the worker had to answer, as `<kind>:<id>`; null when the
   * page never posted it.
   */
  expected: string | null;
  /**
   * What the page's wait ended with, as `<name>: <message>`; null when the
   * page stopped waiting itself.
   */
  error: string | null;
  /** The worker's and the page's events (TracedWorker.events), oldest first. */
  events: string[];
  health: EngineHealth;
  /** A termination probe's guest counter (0: it never ran); null without one. */
  count: number | null;
}

/** Engine operations a trace shows begun and never finished. */
export function unfinished(events: string[]): string[] {
  const begun = new Set<string>();
  for (const event of events) {
    const match = /(?:^|:)((?:compile|instantiate)\d+):(start|end|error)/.exec(
      event,
    );
    if (!match) continue;
    if (match[2] === "start") begun.add(match[1]);
    else begun.delete(match[1]);
  }
  return [...begun];
}

/**
 * Who a stall points at, and the clause of the rule that decided it: the one
 * rule for soak recoveries and termination probes alike.
 *
 * The SDK, when the wait ended with anything but a timeout, which is a
 * failure rather than a stall, or when the page never posted the message: the
 * SDK's client alone decides to post, and postMessage does not fail silently.
 *
 * The engine, when it no longer starts a fresh worker or compiles Wasm; when
 * it never delivered the message (the worker then shows no `message:` event,
 * and no `started` either if the engine never ran its script); when a Wasm
 * compile or instantiation it began never finished (these guests have no
 * start function, so instantiation runs none of their code); when a reply the
 * worker sent never reached the page; or when a probe's guest did run, only
 * late.
 *
 * The SDK otherwise: the engine did its part and stayed healthy, yet the
 * worker never answered, or its guest never ran.
 */
export function judgeStall(
  stall: StallEvidence,
): { suspect: "sdk" | "engine"; because: string } {
  const sdk = (because: string) => ({ suspect: "sdk" as const, because });
  const engine = (because: string) => ({ suspect: "engine" as const, because });
  if (stall.error !== null && !stall.error.startsWith("TimeoutError")) {
    return sdk(`the wait ended with ${stall.error}, a failure, not a stall`);
  }
  const expected = stall.expected;
  if (expected === null) {
    return sdk("the page never posted the message the worker had to answer");
  }
  if (!stall.health.healthy) {
    return engine("the engine no longer starts a worker or compiles Wasm");
  }
  const worker = stall.events.filter((event) => !event.startsWith("page:"))
    .map((event) => event.slice(event.indexOf(":") + 1));
  if (!worker.includes(`message:${expected}`)) {
    return engine(
      worker.includes("started")
        ? `the engine never delivered ${expected} to the worker`
        : "the engine never ran the worker's script",
    );
  }
  const pending = unfinished(worker);
  if (pending.length > 0) {
    return engine(`the engine never finished ${pending.join(", ")}`);
  }
  const id = expected.slice(expected.indexOf(":") + 1);
  const replied = worker.includes(`reply:${id}`) ||
    worker.includes(`reply:${id}:error`);
  if (replied && !stall.events.includes(`page:reply:${id}`)) {
    return engine(
      `the engine never delivered the worker's reply to ${expected}`,
    );
  }
  if ((stall.count ?? 0) > 0) return engine("the guest ran, only late");
  return sdk(
    stall.count === 0
      ? `the engine did its part and stayed healthy, yet the guest of ${expected} never ran`
      : `the engine did its part and stayed healthy, yet the worker never answered ${expected}`,
  );
}

/** Who a stall points at (judgeStall). */
export function stallSuspect(stall: StallEvidence): "sdk" | "engine" {
  return judgeStall(stall).suspect;
}

/** The page's last post of `kind` (any kind when omitted), as `<kind>:<id>`. */
export function lastPost(events: string[], kind?: string): string | null {
  const prefix = `page:post:${kind === undefined ? "" : `${kind}:`}`;
  const post = events.filter((event) => event.startsWith(prefix)).at(-1);
  return post === undefined ? null : post.slice("page:post:".length);
}
