// Evidence for a stalled worker, in the recovery soak (test.ts) and the
// termination acceptance (termination.ts). The trace template is a module
// worker script that loads the SDK's real worker.js (a blob URL substituted
// for __REAL_WORKER_URL__) and reports what the worker does to the page: that
// it started, each message it receives, each Wasm compile and instantiate,
// and each reply. The page records the events per Worker, so a stall shows
// where its worker stopped. Tracing only observes; every call goes through
// unchanged. The health script asks whether the engine itself still starts a
// worker and compiles Wasm, in a worker and on the page.

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
  /** `<ms since the worker started>:<event>`, the most recent last. */
  events: string[];
  terminated: boolean;
}

export const traceWorkerTemplate = `import "__REAL_WORKER_URL__";
const t0 = performance.now();
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
