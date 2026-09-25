// Tracing for the recovery soak (test.ts): a module worker script that loads
// the SDK's real worker.js (a blob URL substituted for __REAL_WORKER_URL__)
// and reports what the worker does to the page: that it started, each message
// it receives, each Wasm compile and instantiate, and each reply. The page
// records the events per Worker, so a recovery that stalls shows where its
// worker stopped. Tracing only observes; every call goes through unchanged.

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
