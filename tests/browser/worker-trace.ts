// Evidence for a stalled worker, and the one rule it is read by, for every
// step of the browser driver (test.ts) that creates or first uses SDK workers
// (stall-rule.ts), the recovery soak, and the termination acceptance
// (termination.ts).
//
// A traced worker is a module worker script that first imports the trace
// module (traceModuleSource) and then its own script: the SDK's worker.js, or
// whatever the page started. Imports evaluate in order, so the trace reports
// that the worker started and listens for messages before that script runs;
// it then reports each message the worker receives, each Wasm compile and
// instantiate, and each reply. Tracing only observes; every call goes through
// unchanged. The page adds its own events to the same list: each message it
// posts to the worker and each reply that reaches it. On the driver's main
// page an init script (workerTracerScript) traces every module worker from
// the start; the termination probes import the module themselves
// (traceWorkerTemplate). The health script asks whether the engine itself
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

/**
 * What the page knows about a traced worker, kept whole whatever the display
 * ring drops, with page times (performance.now() on the page). The page
 * folds every event into it (traceFactsSource).
 */
export interface WorkerFacts {
  /** When the worker's trace reported that it started; null if it never did. */
  started: number | null;
  /**
   * Since when the worker's thread has not come back to its event loop after
   * starting or answering: the trace's `idle:` event ends it. Null while idle.
   */
  busySince: number | null;
  /** What the worker did last before busySince: "starting" or "answering <id>". */
  busyAfter: string | null;
  /** Messages the worker received, `<kind>:<id>` to time. */
  received: Record<string, number>;
  /** Replies the worker posted, id to time. */
  replied: Record<string, number>;
  /** Replies that reached the page, id to time. */
  pageReplies: Record<string, number>;
  /**
   * Wasm compiles and instantiations begun and not finished, by name, and
   * whether an instantiation runs the guest's start function.
   */
  open: Record<string, { at: number; runsStart: boolean }>;
  /** The page's posts to the worker, `<kind>:<id>` to time. */
  posts: Record<string, number>;
  /** When the page terminated the worker; null if it did not. */
  terminated: number | null;
  /** When the latest event from the worker's trace arrived. */
  lastEvent: number | null;
}

/** One traced worker, as the page records it. */
export interface TracedWorker {
  /**
   * The worker's `<ms since it started>:<event>` and the page's
   * `page:post:<kind>:<id>`, `page:reply:<id>` and `page:terminate`, the
   * most recent last: at most 60, for display.
   */
  events: string[];
  terminated: boolean;
  /** Everything the rule judges, whole. */
  facts: WorkerFacts;
}

/**
 * The trace module: imported before worker.js, so it runs first. After the
 * worker starts and after each reply it posts, it queues `idle:<start or
 * id>` for when the worker's thread next returns to its event loop, so a
 * thread that its own code keeps busy shows as such. A module compiled from
 * bytes with a start section runs guest code when it is instantiated, which
 * its `instantiate<n>:start:runs-start` event says.
 */
export const traceModuleSource = `const t0 = performance.now();
const post = self.postMessage.bind(self);
const say = (event) => {
  try { post({ kind: "capnpTrace", event, t: Math.round(performance.now() - t0) }); } catch {}
};
const idle = (after) => setTimeout(() => say("idle:" + after), 0);
say("started");
idle("start");
self.addEventListener("message", ({ data }) => {
  if (data && data.kind) say("message:" + data.kind + (data.id !== undefined ? ":" + data.id : ""));
});
self.postMessage = (message, transfer) => {
  const posted = post(message, transfer);
  if (message && message.id !== undefined) {
    say("reply:" + message.id + (message.error ? ":error" : ""));
    idle(message.id);
  }
  return posted;
};
const hasStartSection = (bytes) => {
  try {
    const view = bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 8;
    while (at < view.length) {
      const id = view[at++];
      let size = 0;
      for (let shift = 0; ; shift += 7) {
        const byte = view[at++];
        size += (byte & 127) * 2 ** shift;
        if (!(byte & 128)) break;
      }
      if (id === 8) return true;
      at += size;
    }
  } catch {}
  return false;
};
const startSections = new WeakSet();
let compiles = 0;
const compile = WebAssembly.compile;
WebAssembly.compile = function (bytes) {
  const n = ++compiles;
  const runsStart = hasStartSection(bytes);
  say("compile" + n + ":start:" + (bytes && bytes.byteLength));
  return compile.call(WebAssembly, bytes).then(
    (module) => {
      if (runsStart) startSections.add(module);
      say("compile" + n + ":end");
      return module;
    },
    (error) => { say("compile" + n + ":error:" + error); throw error; },
  );
};
let instances = 0;
const instantiate = WebAssembly.instantiate;
WebAssembly.instantiate = function (source, imports) {
  const n = ++instances;
  const runsStart = source instanceof WebAssembly.Module
    ? startSections.has(source)
    : hasStartSection(source);
  say("instantiate" + n + ":start" + (runsStart ? ":runs-start" : ""));
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

/**
 * The page's fold of a traced worker's events into its WorkerFacts, as
 * script source that the page's init scripts share: `capnpNewFacts()` makes
 * empty facts, and `capnpFold(facts, event, now)` folds one worker event
 * (`<ms>:<event>`) or page event (`page:...`) that arrived at page time `now`.
 */
export const traceFactsSource = `const capnpNewFacts = () => ({
  started: null, busySince: null, busyAfter: null, received: {}, replied: {},
  pageReplies: {}, open: {}, posts: {}, terminated: null, lastEvent: null,
});
const capnpFold = (facts, event, now) => {
  if (event.startsWith("page:post:")) { facts.posts[event.slice(10)] = now; return; }
  if (event.startsWith("page:reply:")) { facts.pageReplies[event.slice(11)] = now; return; }
  if (event === "page:terminate") { if (facts.terminated === null) facts.terminated = now; return; }
  const name = event.slice(event.indexOf(":") + 1);
  facts.lastEvent = now;
  if (name === "started") {
    facts.started = now; facts.busySince = now; facts.busyAfter = "starting"; return;
  }
  if (name.startsWith("idle:")) { facts.busySince = null; facts.busyAfter = null; return; }
  if (name.startsWith("message:")) { facts.received[name.slice(8)] = now; return; }
  if (name.startsWith("reply:")) {
    const id = name.slice(6).split(":")[0];
    facts.replied[id] = now; facts.busySince = now; facts.busyAfter = "answering " + id;
    return;
  }
  const op = /^((?:compile|instantiate)[0-9]+):(start|end|error)/.exec(name);
  if (op) {
    if (op[2] === "start") facts.open[op[1]] = { at: now, runsStart: name.endsWith(":runs-start") };
    else delete facts.open[op[1]];
  }
};`;

/**
 * Installed as an init script on the driver's main page, before any of its
 * scripts run: every module worker the page creates, the SDK's and the Studio
 * adapter's alike, loads the trace module first. `globalThis.capnpTracer`
 * keeps, per worker, its TracedWorker events and facts, and in order every
 * message the page posts (`posts`: the worker's index, `<kind>:<id>`, and
 * page time); each event also goes to the driver (capnpTraceSink), so a
 * trace outlives a crashed page. terminate() is recorded as `page:terminate`.
 * The driver arms `drill` for CAPNP_BROWSER_WORKER_STALL: the next module
 * worker then never runs its script (`start`), or never receives a message
 * after init (`job`), stalls the engine would cause; or it runs a script that
 * never answers (`silent`), as an SDK fault would.
 */
export const workerTracerScript = `(() => {
  ${traceFactsSource}
  const RealWorker = globalThis.Worker;
  const blob = (source) =>
    URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const traceURL = blob(${JSON.stringify(traceModuleSource)});
  const hangURL = blob("await new Promise(() => {});");
  const silentURL = blob("self.onmessage = () => {};");
  const dropJobsURL = blob(
    'self.addEventListener("message", (event) => {' +
      ' if (!event.data || event.data.kind !== "init") event.stopImmediatePropagation(); });',
  );
  const tracer = globalThis.capnpTracer = { workers: [], posts: [], drill: null };
  const byWorker = new WeakMap();
  const keep = (traced, event) => {
    capnpFold(traced.facts, event, performance.now());
    traced.events.push(event);
    if (traced.events.length > 60) traced.events.splice(0, 20);
    const sink = globalThis.capnpTraceSink;
    if (!sink) return;
    try {
      const sent = sink(tracer.workers.indexOf(traced), event);
      if (sent && sent.catch) sent.catch(() => {});
    } catch {}
  };
  globalThis.Worker = class extends RealWorker {
    constructor(url, options) {
      let target = url;
      if (options && options.type === "module") {
        const script = new URL(url, location.href).href;
        let source = 'import "' + traceURL + '";\\nimport "' + script + '";\\n';
        const drill = tracer.drill;
        if (drill && drill.remaining > 0) {
          drill.remaining--;
          source = drill.mode === "silent"
            ? 'import "' + traceURL + '";\\nimport "' + silentURL + '";\\n'
            : drill.mode === "job"
              ? 'import "' + dropJobsURL + '";\\n' + source
              : 'import "' + hangURL + '";\\n';
        }
        target = blob(source);
      }
      super(target, options);
      const traced = { events: [], terminated: false, facts: capnpNewFacts() };
      tracer.workers.push(traced);
      byWorker.set(this, traced);
      this.addEventListener("message", (event) => {
        const data = event.data;
        if (data && data.kind === "capnpTrace") keep(traced, data.t + ":" + data.event);
        else if (data && typeof data.id === "number") keep(traced, "page:reply:" + data.id);
      });
    }
    postMessage(message, transfer) {
      const traced = byWorker.get(this);
      if (traced && message && typeof message.kind === "string") {
        const post = message.kind + (message.id !== undefined ? ":" + message.id : "");
        tracer.posts.push({
          worker: tracer.workers.indexOf(traced),
          post,
          at: performance.now(),
        });
        keep(traced, "page:post:" + post);
      }
      return transfer === undefined
        ? super.postMessage(message)
        : super.postMessage(message, transfer);
    }
    terminate() {
      const traced = byWorker.get(this);
      if (traced) {
        traced.terminated = true;
        keep(traced, "page:terminate");
      }
      super.terminate();
    }
  };
})();`;

/** The page's tracer (workerTracerScript), as the driver's page functions read it. */
export interface PageTracer {
  workers: TracedWorker[];
  posts: { worker: number; post: string; at: number }[];
  drill: { mode: "start" | "job" | "silent"; remaining: number } | null;
}

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
  /** The worker's and the page's events (TracedWorker.events), for display. */
  events: string[];
  health: EngineHealth;
  /** A termination probe's guest counter (0: it never ran); null without one. */
  count: number | null;
  /** The worker's facts, which the rule judges; null when no worker had to answer. */
  facts: WorkerFacts | null;
  /** When the page took this evidence (page time, as in the facts). */
  at: number;
  /**
   * With no message to answer: true when the page posted during the step and
   * every reply reached it.
   */
  answered?: boolean;
}

/**
 * How long a stalled item must have gone without progress before the rule
 * blames the engine for it: a worker that never started, a message never
 * delivered to an idle worker, an unfinished compile or instantiation, a
 * reply never delivered. Each normally takes milliseconds. The time counts
 * from the item, or from the worker's latest event if that came later; a
 * stall with less quiet than this is slowness.
 */
export const stallFloorMs = 5_000;

/** Who a stall points at: the engine, the SDK, or neither, only slowness. */
export type StallSuspect = "sdk" | "engine" | "slow";

/** The words a failure message uses for a verdict. */
export function verdictWords(suspect: StallSuspect): string {
  return suspect === "slow"
    ? "shows slowness rather than a stall"
    : suspect === "sdk"
    ? "points at the SDK"
    : "points at the engine";
}

/**
 * Who a stall points at, and the clause of the rule that decided it: the one
 * rule for every driver step, soak recovery, and termination probe. It reads
 * the worker's facts, not its display events.
 *
 * The SDK, when the wait ended with anything but a timeout, which is a
 * failure rather than a stall; when the page never posted the message, or
 * every reply reached the page and the client still did not settle; when the
 * page posted to a worker it had terminated, or one still working on an
 * earlier message; when the worker's own code held its thread after starting
 * or answering, so the message could not be taken; when an unfinished
 * instantiation runs the guest's start function, which is guest code the SDK
 * must stop; or when the engine did its part and stayed healthy, yet the
 * worker never answered or its guest never ran.
 *
 * The engine, when it no longer starts a fresh worker or compiles Wasm; when
 * it never ran the worker's script; when it never delivered the message to an
 * idle worker; when a Wasm compile or instantiation it began never finished;
 * when it never delivered a reply the worker sent; or when a probe's guest
 * did run, only late. Each such item must have gone stallFloorMs without
 * progress at the stall: that long since it began and since the worker's
 * latest event. Otherwise the stall is slowness, which fails the step too.
 */
export function judgeStall(
  stall: StallEvidence,
): { suspect: StallSuspect; because: string } {
  const verdict = (suspect: StallSuspect) => (because: string) => ({
    suspect,
    because,
  });
  const sdk = verdict("sdk");
  const engine = verdict("engine");
  const slow = verdict("slow");
  if (stall.error !== null && !stall.error.startsWith("TimeoutError")) {
    return sdk(`the wait ended with ${stall.error}, a failure, not a stall`);
  }
  const expected = stall.expected;
  if (expected === null) {
    return sdk(
      stall.answered
        ? "every message the page posted during the step was answered at the page, yet the SDK's client did not settle"
        : "the page never posted the message the worker had to answer",
    );
  }
  const facts = stall.facts;
  if (facts === null) {
    return sdk(
      `the page kept no facts about the worker it posted ${expected} to`,
    );
  }
  if (!stall.health.healthy) {
    return engine("the engine no longer starts a worker or compiles Wasm");
  }
  const posted = facts.posts[expected];
  // How long nothing happened, at the stall, since the item began at `at`
  // or since the worker's latest event, whichever came later.
  const quiet = (at: number | undefined) =>
    stall.at - Math.max(at ?? -Infinity, facts.lastEvent ?? -Infinity);
  const stale = (at: number | undefined) => quiet(at) >= stallFloorMs;
  const recent = (at: number | undefined) =>
    `and the latest progress was only ${
      Math.round(quiet(at))
    } ms before the stall`;
  if (
    facts.terminated !== null && posted !== undefined &&
    posted >= facts.terminated
  ) {
    return sdk(`the page posted ${expected} to a worker it had terminated`);
  }
  if (facts.started === null) {
    return stale(posted)
      ? engine("the engine never ran the worker's script")
      : slow(`the worker had not started, ${recent(posted)}`);
  }
  const idOf = (message: string) => message.slice(message.indexOf(":") + 1);
  if (facts.received[expected] === undefined) {
    const working = Object.keys(facts.received).find((message) =>
      facts.replied[idOf(message)] === undefined
    );
    if (working !== undefined) {
      return sdk(
        `the page posted ${expected} while the worker still worked on ${working}`,
      );
    }
    if (facts.busySince !== null) {
      return sdk(
        `the worker's own code held its thread after ${facts.busyAfter}, so it never took ${expected}`,
      );
    }
    return stale(posted)
      ? engine(`the engine never delivered ${expected} to the idle worker`)
      : slow(`the idle worker had not received ${expected}, ${recent(posted)}`);
  }
  const id = idOf(expected);
  if (facts.replied[id] !== undefined) {
    if (facts.pageReplies[id] !== undefined) {
      return sdk(
        `the worker's reply to ${expected} reached the page, yet the SDK's client did not settle`,
      );
    }
    return stale(facts.replied[id])
      ? engine(`the engine never delivered the worker's reply to ${expected}`)
      : slow(
        `the worker's reply to ${expected} had not reached the page, ${
          recent(facts.replied[id])
        }`,
      );
  }
  const open = Object.entries(facts.open);
  const guestStart = open.find(([, op]) => op.runsStart);
  if (guestStart !== undefined) {
    return sdk(
      `${
        guestStart[0]
      } runs the guest's start function, guest code the SDK must stop, and never finished`,
    );
  }
  if (open.length > 0) {
    const names = open.map(([name]) => name).join(", ");
    const latest = Math.max(...open.map(([, op]) => op.at));
    return stale(latest)
      ? engine(`the engine never finished ${names}`)
      : slow(`${names} was still in progress, ${recent(latest)}`);
  }
  if ((stall.count ?? 0) > 0) return engine("the guest ran, only late");
  return sdk(
    stall.count === 0
      ? `the engine did its part and stayed healthy, yet the guest of ${expected} never ran`
      : `the engine did its part and stayed healthy, yet the worker never answered ${expected}`,
  );
}

/** Who a stall points at (judgeStall). */
export function stallSuspect(stall: StallEvidence): StallSuspect {
  return judgeStall(stall).suspect;
}
