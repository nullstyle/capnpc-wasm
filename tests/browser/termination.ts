// Termination acceptance (TST-04, GAP2-V1): does SDK cancellation stop a
// running Wasm guest in this engine? A probe worker script wraps the SDK's own
// worker.js and patches WebAssembly.instantiate in the worker scope, so the
// whole SDK path runs (client, worker protocol, instrumentation, WASI start)
// while the probe counts the guest's progress in shared memory the page reads.
// Two guests, each the job's own module:
//
//   pure  spin-counter.wat loops without ever calling an import, like a guest
//         stuck computing (GAP2-V1's case). Only the SDK's injected checks
//         leave Wasm: the probe counts the guest's polls of the
//         capnp_wasm.interrupt import, one per 65,536 loop iterations.
//   host  spin-yield.wat calls WASI sched_yield on every iteration; the probe
//         counts the calls.
//
// The SDK stops both inside the worker, whatever terminate() does: a timeout
// at the deadline the worker enforces itself, an abort or dispose through the
// shared cell. After a timeout or an abort the page waits out the client's
// one-second grace (watching the counter where there is one) before it runs a
// follow-up job on the same client: a guest still running at the end of the
// grace would have made the client terminate its worker, which the audit
// counts, so no terminate() call and no second worker mean the guest reported.
//
// Under cross-origin isolation (COOP/COEP) the counter is shared memory, which
// keeps counting whether or not the worker's message port is open after
// terminate(). Without isolation there is no shared memory: the rejection, the
// terminate() calls, and the follow-up job can be observed, not the guest.
//
// A sample measures a cancellation only once its worker started and its guest
// ran. A probe worker whose initialization times out after startBoundMs, or a
// guest that does not run within that bound (or, in a timeout job, before its
// deadline), is a start stall: the sample returns the worker's trace, the
// page's posts to it and the replies that reached the page (worker-trace.ts),
// and whether the engine still starts workers and compiles Wasm. Any other
// failure is the check's own. judgeStall() in worker-trace.ts, the rule the
// recovery soak uses too, reads the evidence; a stall that points at the
// engine is retried once and then handed to the caller's stall budget
// (soak-stalls.ts), and any other fails the check.
import type { Engine } from "./engines.ts";
import { settleGraceMs } from "../../sdk/typescript/interrupt.ts";
import {
  type EngineHealth,
  judgeStall,
  type StallEvidence,
  stallSuspect,
  traceModuleSource,
  traceWorkerTemplate,
} from "./worker-trace.ts";

/**
 * Milliseconds a guest may keep running after its job was cancelled. The
 * SDK's in-guest checks stop a guest within a millisecond of the cancellation
 * (measured idle in Chromium and WebKit). The probe records when the guest
 * last called the counted import, on the worker's own clock, so the stop time
 * is exact and a page that samples late cannot stretch it. The bound is two
 * thousand times that idle stop, for loaded CI hosts, and every engine
 * shares it. The page watches until the counter has been still for `quietMs`,
 * or until the guest has run past the bound.
 */
export const terminationBoundMs = 2_000;

/** A counter that has not moved for this long has stopped. */
export const quietMs = 1_000;

/**
 * How long the worker client waits for a cancelled job to report before it
 * terminates the worker, plus a margin. The page waits this long before a
 * follow-up job.
 */
export const clientGraceMs = settleGraceMs + 200;

/**
 * The SDK deadline for the timeout case without isolation, where nothing
 * shows the guest, and for every follow-up job.
 */
export const timeoutMs = 300;

/**
 * The SDK deadline for the timeout case under isolation: long enough that the
 * page sees the guest run before the deadline stops it. A guest normally runs
 * within milliseconds of its job; one that has not shown a 50 ms window of
 * progress before this deadline is a start stall.
 */
export const isolatedTimeoutMs = 2_000;

/**
 * How long a probe worker may take to initialize, and an abort or dispose
 * sample's guest to start running, before the sample is a start stall. Both
 * take milliseconds normally, and at most a few hundred on loaded CI hosts.
 */
export const startBoundMs = 10_000;

/**
 * The deadline of an abort or dispose job: far past the start bound, so only
 * the intended cancellation can end the job.
 */
export const cancelDeadlineMs = 60_000;

export type TerminationGuest = "pure" | "host";
export type TerminationMode = "timeout" | "abort" | "dispose";

/**
 * Installed in every termination context before its page loads: counts the
 * workers the SDK creates and terminates, collects the counter each probe
 * worker posts before it handles any message, and keeps each worker's trace
 * events (worker-trace.ts) with the page's own: each message it posts to the
 * worker, `page:post:<kind>:<id>`, and each reply that reaches it,
 * `page:reply:<id>`.
 */
export const workerAuditScript = `(() => {
  const RealWorker = globalThis.Worker;
  const audit = globalThis.capnpWorkerAudit = {
    created: 0,
    terminated: 0,
    probes: [],
    traces: [],
  };
  const keep = (events, event) => {
    events.push(event);
    if (events.length > 60) events.splice(0, 20);
  };
  globalThis.Worker = class extends RealWorker {
    constructor(...args) {
      super(...args);
      audit.created++;
      const events = [];
      audit.traces.push(events);
      this.capnpEvents = events;
      this.addEventListener("message", (event) => {
        const data = event.data;
        if (data && data.kind === "capnpProbe") {
          audit.probes.push(data.counter ? new Int32Array(data.counter) : null);
        }
        if (data && data.kind === "capnpTrace") keep(events, data.t + ":" + data.event);
        else if (data && typeof data.id === "number") keep(events, "page:reply:" + data.id);
      });
    }
    postMessage(message, transfer) {
      if (message && message.kind) {
        keep(this.capnpEvents, "page:post:" + message.kind +
          (message.id !== undefined ? ":" + message.id : ""));
      }
      return transfer === undefined
        ? super.postMessage(message)
        : super.postMessage(message, transfer);
    }
    terminate() {
      audit.terminated++;
      super.terminate();
    }
  };
})();`;

/**
 * The probe worker script: the trace template (worker-trace.ts), which
 * statically imports the trace module and then the real worker.js (blob URLs
 * substituted in), so the SDK's message handler exists before any message
 * arrives; then the counter. It patches WebAssembly.instantiate so that each
 * call of the counted import adds one to the counter's first cell and writes
 * the worker's clock, in whole milliseconds, to its second, and posts the
 * counter. __GUEST__ is "pure" or "host": the import whose calls count.
 */
const probeWorkerTemplate = `${traceWorkerTemplate}
const guest = "__GUEST__";
let counter = null;
try {
  counter = new Int32Array(new SharedArrayBuffer(8));
} catch {
  counter = null;
}
const countedInstantiate = WebAssembly.instantiate;
WebAssembly.instantiate = function (source, imports) {
  const counted = guest === "pure"
    ? [imports && imports.capnp_wasm, "interrupt"]
    : [imports && imports.wasi_snapshot_preview1, "sched_yield"];
  const [namespace, name] = counted;
  if (counter && namespace && typeof namespace[name] === "function") {
    const inner = namespace[name];
    namespace[name] = function () {
      Atomics.add(counter, 0, 1);
      Atomics.store(counter, 1, Math.round(performance.now()));
      return inner.apply(this, arguments);
    };
  }
  return countedInstantiate.call(WebAssembly, source, imports);
};
try {
  self.postMessage({ kind: "capnpProbe", counter: counter ? counter.buffer : null });
} catch {
  counter = null;
  self.postMessage({ kind: "capnpProbe", counter: null });
}
`;

/**
 * A probe worker that did not start in time, with the page's evidence. The
 * expected message is the page's init post, or its compile post once the
 * worker initialized; the error is the init's or the timeout job's
 * TimeoutError, and null for an abort or dispose, whose wait the page ended.
 */
export interface StartStall extends StallEvidence {
  /** "init": the worker never finished initializing; "start": its guest never ran in time. */
  stage: "init" | "start";
  /** What did not happen, in one clause. */
  reason: string;
  /** Milliseconds the page waited. */
  afterMs: number;
}

/** What one cancellation did, as measured in the page. */
export interface TerminationSample {
  guest: TerminationGuest;
  mode: TerminationMode;
  /** Set when the probe worker did not start in time; nothing else was measured. */
  stall: StartStall | null;
  /** Whether the probe could share a counter (cross-origin isolation). */
  hasCounter: boolean;
  /** The counter when the job was cancelled; positive means the guest ran. */
  countBeforeCancel: number | null;
  /**
   * How far the counter moved in a 50 ms window before the cancellation (the
   * last window for an abort or dispose, the largest for a timeout). It must
   * be positive: a guest whose counter moves more slowly than the sampling
   * could otherwise read as stopped at once.
   */
  advanceBeforeCancel: number | null;
  atRejection: number | null;
  final: number | null;
  rejection: { name: string; message: string };
  /** Milliseconds from the job's start until it rejected. */
  rejectionAfterMs: number;
  /**
   * Worker-clock milliseconds from the guest's latest counted call at the
   * cancellation to its last one; null when it ran past the bound.
   */
  stoppedAfterMs: number | null;
  /**
   * After a timeout or abort, a second job on the same client, which times
   * out in its turn: its rejection, and milliseconds until it rejected.
   */
  followUp: { name: string; afterMs: number } | null;
  /** terminate() calls before the harness disposes the client. */
  terminateCalls: number;
  workersCreated: number;
}

export interface TerminationResult {
  engine: Engine;
  /** The driver's operating system (Deno.build.os). */
  os: string;
  /** Every sample's stop time, for the OBSERVED line CI records. */
  observed: string;
  crossOriginIsolated: boolean;
  boundMs: number;
  samples: TerminationSample[];
  verdict: string;
}

type Evaluate = <T, A>(
  fn: (argument: A) => Promise<T> | T,
  argument: A,
  label: string,
) => Promise<T>;

/**
 * Where a start stall that points at the engine goes once its retry passed:
 * the run's stall budget, which throws when the stall exceeds it.
 */
export type TolerateStall = (label: string, stall: StartStall) => Promise<void>;

/** Without a stall budget every start stall fails the check. */
const refuseStalls: TolerateStall = (label, stall) =>
  Promise.reject(
    new Error(`${label}: ${describeStall(stall)}: ${JSON.stringify(stall)}`),
  );

/**
 * Prepare a termination page: load the SDK, build the two probe workers
 * around the real worker.js, and keep each guest's module. Runs while the
 * asset server is still up; everything later runs from memory.
 */
export async function setupTermination(
  evaluate: Evaluate,
  spinGuest: Uint8Array,
  counterModule: Uint8Array,
  label: string,
): Promise<{ crossOriginIsolated: boolean }> {
  return await evaluate(async (
    { spinGuest, template, traceModule, counterModule },
  ) => {
    const sdk = await import(new URL("/sdk/mod.js", location.href).href);
    const workerSource = await (await fetch("/sdk/worker.js")).text();
    const blobURL = (source: string) =>
      URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const realURL = blobURL(workerSource);
    const traceURL = blobURL(traceModule);
    const probeURLs: Record<string, string> = {};
    for (const guest of ["pure", "host"]) {
      const source = template
        .replace("__TRACE_URL__", traceURL)
        .replace("__REAL_WORKER_URL__", realURL)
        .replace("__GUEST__", guest);
      probeURLs[guest] = URL.createObjectURL(
        new Blob([source], { type: "text/javascript" }),
      );
    }
    const modules = {
      pure: { compiler: new Uint8Array(counterModule), generators: {} },
      host: { compiler: spinGuest, generators: {} },
    };
    (globalThis as unknown as { capnpTermination: unknown }).capnpTermination =
      { sdk, modules, probeURLs };
    const scope = globalThis as unknown as { crossOriginIsolated?: boolean };
    return { crossOriginIsolated: scope.crossOriginIsolated === true };
  }, {
    spinGuest,
    template: probeWorkerTemplate,
    traceModule: traceModuleSource,
    counterModule: Array.from(counterModule),
  }, label);
}

/**
 * Cancel a spinning guest one way and watch the shared counter afterwards.
 * `bounds` overrides the timeout case's deadline (isolatedTimeoutMs by
 * default; checkPlainTermination passes timeoutMs) and the start bound.
 */
export async function measureTermination(
  evaluate: Evaluate,
  guest: TerminationGuest,
  mode: TerminationMode,
  label: string,
  bounds: { timeoutMs?: number; startMs?: number } = {},
): Promise<TerminationSample> {
  return await evaluate(
    async ({
      guest,
      mode,
      jobTimeoutMs,
      followUpMs,
      cancelMs,
      startMs,
      boundMs,
      quietMs,
      graceMs,
    }) => {
      type Client = {
        compile(
          job: unknown,
          options?: { signal?: AbortSignal; timeoutMs?: number },
        ): Promise<unknown>;
        dispose(): void;
      };
      type Outcome = { name: string; message: string };
      const state = (globalThis as unknown as {
        capnpTermination: {
          sdk: {
            createWorkerCompiler(
              url: string,
              modules: unknown,
              options?: { initTimeoutMs?: number },
            ): Promise<Client>;
          };
          modules: Record<string, unknown>;
          probeURLs: Record<string, string>;
        };
      }).capnpTermination;
      const audit = (globalThis as unknown as {
        capnpWorkerAudit: {
          created: number;
          terminated: number;
          probes: (Int32Array | null)[];
          traces: string[][];
        };
      }).capnpWorkerAudit;
      const engineHealth = (globalThis as unknown as {
        capnpEngineHealth(): Promise<EngineHealth>;
      }).capnpEngineHealth;
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms));
      const probesBefore = audit.probes.length;
      const terminatedBefore = audit.terminated;
      const createdBefore = audit.created;
      const sample: TerminationSample = {
        guest,
        mode,
        stall: null,
        hasCounter: false,
        countBeforeCancel: null,
        advanceBeforeCancel: null,
        atRejection: null,
        final: null,
        rejection: { name: "none", message: "" },
        rejectionAfterMs: 0,
        stoppedAfterMs: null,
        followUp: null,
        terminateCalls: 0,
        workersCreated: 0,
      };
      // The evidence for a start stall: the sample's worker is the first one
      // created from here on. Its events are kept before the health checks,
      // which start workers of their own. The worker had to answer the page's
      // init, or once initialized its compile.
      const stalled = async (
        stage: "init" | "start",
        reason: string,
        since: number,
        error: string | null,
        count: number | null,
      ): Promise<TerminationSample> => {
        const afterMs = Math.round(performance.now() - since);
        const trace = [...(audit.traces[createdBefore] ?? [])];
        const kind = stage === "init" ? "init" : "compile";
        const post = trace.filter((event) =>
          event.startsWith(`page:post:${kind}:`)
        ).at(-1);
        const expected = post === undefined
          ? null
          : post.slice("page:post:".length);
        const health = await engineHealth();
        return {
          ...sample,
          hasCounter: count !== null,
          stall: {
            stage,
            reason,
            afterMs,
            expected,
            error,
            // The whole trace: the audit keeps at most 60 events per worker.
            events: trace,
            count,
            health,
          },
        };
      };
      const errorText = (error: unknown) =>
        `${(error as Error).name}: ${
          String((error as Error).message).slice(0, 120)
        }`;
      const initStarted = performance.now();
      let client: Client;
      try {
        client = await state.sdk.createWorkerCompiler(
          state.probeURLs[guest],
          state.modules[guest],
          { initTimeoutMs: startMs },
        );
      } catch (error) {
        // Only an initialization that timed out is a start stall; the factory
        // failing in any other way fails the check.
        if ((error as Error)?.name !== "TimeoutError") {
          throw new Error(
            `the probe worker failed to initialize: ${errorText(error)}`,
          );
        }
        return await stalled(
          "init",
          `the probe worker did not initialize within ${startMs} ms`,
          initStarted,
          errorText(error),
          null,
        );
      }
      // The probe posts its counter before it handles the init message, so
      // the counter arrives before the factory resolves.
      const counter = audit.probes[probesBefore] ?? null;
      // Unsigned: a guest that is never stopped keeps counting for the rest
      // of the run.
      const read = () => counter ? Atomics.load(counter, 0) >>> 0 : null;
      // The worker-clock millisecond of the guest's latest counted call.
      const lastCall = () => counter ? Atomics.load(counter, 1) : 0;
      const job = {
        files: { "a.capnp": "" },
        entrypoints: ["a.capnp"],
        generators: [],
      };
      const started = performance.now();
      const controller = new AbortController();
      const outcome: {
        value: Outcome | null;
        at: number;
        cancelCall: number | null;
      } = { value: null, at: 0, cancelCall: null };
      const settled =
        (mode === "timeout"
          ? client.compile(job, { timeoutMs: jobTimeoutMs })
          : mode === "abort"
          ? client.compile(job, {
            signal: controller.signal,
            timeoutMs: cancelMs,
          })
          : client.compile(job, { timeoutMs: cancelMs })).then(
            (): Outcome => ({ name: "resolved", message: "the job completed" }),
            (error: unknown): Outcome => ({
              name: (error as Error).name,
              message: String((error as Error).message).slice(0, 120),
            }),
          ).then((value) => {
            outcome.value = value;
            outcome.at = performance.now();
            // A timeout cancels the job on this thread, just before this runs.
            outcome.cancelCall ??= lastCall();
            return value;
          });
      if (counter) {
        // Cancel only once the guest runs: its counter moved within one 50 ms
        // window just before the cancellation. A timeout's deadline cancels
        // the job itself; keep the largest window's advance before it (with
        // the slack checkPlainTermination allows, should the deadline be late).
        const bound = mode === "timeout" ? jobTimeoutMs + 5_000 : startMs;
        let advance = 0;
        let previous = read()!;
        while (!outcome.value && performance.now() - started < bound) {
          await sleep(mode === "timeout" || previous > 0 ? 50 : 10);
          if (outcome.value) break;
          const latest = read()!;
          if (previous > 0) advance = Math.max(advance, latest - previous);
          previous = latest;
          if (mode !== "timeout" && advance > 0) break;
        }
        sample.countBeforeCancel = previous;
        sample.advanceBeforeCancel = advance;
        if (mode === "timeout" && !outcome.value) {
          client.dispose();
          throw new Error(
            `the job did not time out within ${bound} ms of its start, although its deadline was ${jobTimeoutMs} ms`,
          );
        }
        // No cancellation could be measured: the guest never ran for a whole
        // window before its own deadline stopped it, or within the start bound
        // of an abort or dispose job. A job that ended any other way is not a
        // stall; its outcome goes to the checks below.
        const timedOut = outcome.value?.name === "TimeoutError" &&
          outcome.at - started >= jobTimeoutMs - 10;
        if (advance === 0 && (mode === "timeout" ? timedOut : !outcome.value)) {
          client.dispose();
          await settled;
          return await stalled(
            "start",
            mode === "timeout"
              ? `the guest did not run for a 50 ms window before its ${jobTimeoutMs} ms deadline`
              : `the guest did not run for a 50 ms window within ${startMs} ms of its job`,
            started,
            mode === "timeout"
              ? `${outcome.value!.name}: ${outcome.value!.message}`
              : null,
            previous,
          );
        }
      } else if (mode !== "timeout") await sleep(100);
      if (!outcome.value && mode !== "timeout") {
        outcome.cancelCall = lastCall();
        if (mode === "abort") controller.abort();
        if (mode === "dispose") client.dispose();
      }
      const rejection = await settled;
      const rejectedAt = outcome.at;
      const atRejection = read();
      let stoppedAfterMs: number | null = null;
      if (counter) {
        // Watch until the counter has been still for quietMs of page time, or
        // until the guest's own clock shows it ran past the bound.
        const cancelCall = outcome.cancelCall!;
        const giveUp = performance.now() + boundMs + quietMs + 10_000;
        let last = atRejection;
        let lastChange = performance.now();
        while (performance.now() < giveUp) {
          await sleep(50);
          const value = read();
          const ranFor = lastCall() - cancelCall;
          if (ranFor > boundMs) break;
          if (value !== last) {
            last = value;
            lastChange = performance.now();
          } else if (performance.now() - lastChange >= quietMs) {
            stoppedAfterMs = Math.max(0, ranFor);
            break;
          }
        }
      }
      // Wait out the client's grace in any case (the loop above may end
      // sooner): a guest that had not reported by then would have made the
      // client terminate its worker, which terminateCalls then shows.
      const waited = performance.now() - rejectedAt;
      if (waited < graceMs) await sleep(graceMs - waited);
      const final = read();
      // A timeout or abort keeps the worker: the next job runs on it once the
      // cancelled guest has stopped, and times out in its turn.
      let followUp: { name: string; afterMs: number } | null = null;
      if (mode !== "dispose") {
        const followed = performance.now();
        try {
          await client.compile(job, { timeoutMs: followUpMs });
          followUp = { name: "resolved", afterMs: 0 };
        } catch (error) {
          followUp = { name: (error as Error).name, afterMs: 0 };
        }
        followUp.afterMs = Math.round(performance.now() - followed);
      }
      const terminateCalls = audit.terminated - terminatedBefore;
      const workersCreated = audit.created - createdBefore;
      if (mode !== "dispose") client.dispose();
      return {
        ...sample,
        hasCounter: counter !== null,
        atRejection,
        final,
        rejection,
        rejectionAfterMs: Math.round(rejectedAt - started),
        stoppedAfterMs,
        followUp,
        terminateCalls,
        workersCreated,
      };
    },
    {
      guest,
      mode,
      jobTimeoutMs: bounds.timeoutMs ?? isolatedTimeoutMs,
      followUpMs: timeoutMs,
      cancelMs: cancelDeadlineMs,
      startMs: bounds.startMs ?? startBoundMs,
      boundMs: terminationBoundMs,
      quietMs,
      graceMs: clientGraceMs,
    },
    label,
  );
}

export { stallSuspect };

/** One line for a start stall: what did not happen, where it stopped, health. */
export function describeStall(stall: StartStall): string {
  const last = stall.events.at(-1);
  return `${stall.reason}${stall.error ? ` (${stall.error})` : ""}; ${
    stall.expected === null
      ? `the page never posted ${stall.stage === "init" ? "init" : "the job"}`
      : last === undefined
      ? "the worker reported no event"
      : `the last event: ${last}`
  }; fresh worker ${stall.health.plainWorker}, Wasm in a worker ${stall.health.workerCompile}, Wasm on the page ${stall.health.pageCompile}`;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Measure one sample. A start stall that points at the engine is retried
 * once, and the stall then goes to `tolerate`; a stall that points at the
 * SDK, or a second one, fails the check.
 */
async function measureOrRetry(
  evaluate: Evaluate,
  guest: TerminationGuest,
  mode: TerminationMode,
  label: string,
  bounds: { timeoutMs?: number },
  tolerate: TolerateStall,
): Promise<TerminationSample> {
  const first = await measureTermination(evaluate, guest, mode, label, bounds);
  if (!first.stall) return first;
  const { suspect, because } = judgeStall(first.stall);
  assert(
    suspect === "engine",
    `${label}: ${
      describeStall(first.stall)
    }; the evidence points at the SDK: ${because}: ${
      JSON.stringify(first.stall)
    }`,
  );
  const retried = await measureTermination(
    evaluate,
    guest,
    mode,
    `${label}, retried after a start stall`,
    bounds,
  );
  assert(
    !retried.stall,
    `${label}: the probe worker stalled twice: ${
      describeStall(first.stall)
    }; then ${retried.stall ? describeStall(retried.stall) : ""}: ${
      JSON.stringify([first.stall, retried.stall])
    }`,
  );
  await tolerate(label, first.stall);
  return retried;
}

const expectedRejection: Record<TerminationMode, string> = {
  timeout: "TimeoutError",
  abort: "AbortError",
  dispose: "Error",
};

function describe(samples: TerminationSample[]): string {
  return samples.map((sample) =>
    `${sample.mode} ${
      sample.stoppedAfterMs === null
        ? `kept running (${sample.atRejection} -> ${sample.final})`
        : `${sample.stoppedAfterMs} ms`
    }`
  ).join(", ");
}

/**
 * What a cancellation must leave behind besides a stopped guest: dispose
 * terminates the one worker, while a timeout or abort keeps it, and the same
 * client then runs a follow-up job, which times out in its turn, without a
 * replacement worker.
 */
function checkWorker(sample: TerminationSample, label: string): void {
  const terminations = sample.mode === "dispose" ? 1 : 0;
  assert(
    sample.workersCreated === 1 && sample.terminateCalls === terminations,
    `${label}: ${sample.workersCreated} workers created and ${sample.terminateCalls} terminated, expected 1 and ${terminations}`,
  );
  if (sample.mode === "dispose") return;
  assert(
    sample.followUp?.name === "TimeoutError",
    `${label}: the follow-up job on the same client ended with ${sample.followUp?.name}, expected TimeoutError`,
  );
}

/**
 * The cross-origin-isolated acceptance, the same in every engine: after a
 * timeout, an abort, and a dispose, both guests' counters stop within the
 * bound, and the worker survives the timeout and the abort. Start stalls go
 * to `tolerate` (see measureOrRetry); without it they fail the check.
 */
export async function checkIsolatedTermination(
  engine: Engine,
  evaluate: Evaluate,
  os: string = Deno.build.os,
  tolerate: TolerateStall = refuseStalls,
): Promise<TerminationResult> {
  const samples: TerminationSample[] = [];
  for (const guest of ["pure", "host"] as const) {
    for (const mode of ["timeout", "abort", "dispose"] as const) {
      const sample = await measureOrRetry(
        evaluate,
        guest,
        mode,
        `${engine} isolated termination ${guest} ${mode}`,
        {},
        tolerate,
      );
      samples.push(sample);
      const label = `${engine} ${guest} guest, ${mode}`;
      assert(
        sample.hasCounter,
        `${label}: the probe shared no counter although the page is cross-origin isolated`,
      );
      assert(
        sample.rejection.name === expectedRejection[mode],
        `${label}: rejected with ${sample.rejection.name} (${sample.rejection.message}), expected ${
          expectedRejection[mode]
        }`,
      );
      assert(
        (sample.countBeforeCancel ?? 0) > 0,
        `${label}: the guest had not started when the job was cancelled`,
      );
      assert(
        (sample.advanceBeforeCancel ?? 0) > 0,
        `${label}: the guest's counter did not move within 50 ms before the cancellation, so its stop could not be observed`,
      );
      checkWorker(sample, label);
    }
  }
  const pure = samples.filter((sample) => sample.guest === "pure");
  const host = samples.filter((sample) => sample.guest === "host");
  const summary = `pure Wasm: ${describe(pure)}; host calls: ${describe(host)}`;
  const observed = `${engine} termination on ${os}: ${summary}`;
  const running = samples.filter((sample) =>
    sample.stoppedAfterMs === null || sample.stoppedAfterMs > terminationBoundMs
  );
  assert(
    running.length === 0,
    `${engine} on ${os}: a guest kept running past the ${terminationBoundMs} ms bound after ${
      running.map((sample) => `${sample.guest} ${sample.mode}`).join(", ")
    } (${summary})`,
  );
  return {
    engine,
    os,
    observed,
    crossOriginIsolated: true,
    boundMs: terminationBoundMs,
    samples,
    verdict:
      `PASS ${engine}: timeout, abort, and dispose stop both guests within ${terminationBoundMs} ms, and the worker survives the timeout and the abort (${summary})`,
  };
}

/**
 * Without cross-origin isolation the engine offers no shared memory, so guest
 * CPU cannot be observed directly. The timeout must still reject within its
 * deadline, and after the page has waited out the client's grace (clientGraceMs)
 * no worker may have been terminated or replaced: a guest that had not
 * reported by then would have made the client terminate its worker. The
 * follow-up job then runs on the same worker and times out in its turn. A
 * worker that does not initialize is a start stall, as under isolation.
 */
export async function checkPlainTermination(
  engine: Engine,
  evaluate: Evaluate,
  tolerate: TolerateStall = refuseStalls,
): Promise<TerminationResult> {
  const sample = await measureOrRetry(
    evaluate,
    "pure",
    "timeout",
    `${engine} plain termination timeout`,
    { timeoutMs },
    tolerate,
  );
  const label = `${engine} without isolation`;
  assert(
    sample.rejection.name === "TimeoutError",
    `${label}: rejected with ${sample.rejection.name} (${sample.rejection.message}), expected TimeoutError`,
  );
  assert(
    sample.rejectionAfterMs < timeoutMs + 5_000,
    `${label}: the timeout rejected after ${sample.rejectionAfterMs} ms`,
  );
  checkWorker(sample, label);
  return {
    engine,
    os: Deno.build.os,
    observed:
      `${engine} termination on ${Deno.build.os} without isolation: timeout rejected after ${sample.rejectionAfterMs} ms, follow-up job ${sample.followUp?.name} after ${sample.followUp?.afterMs} ms on the same worker`,
    crossOriginIsolated: false,
    boundMs: terminationBoundMs,
    samples: [sample],
    verdict:
      `PASS ${engine}: without cross-origin isolation the timeout rejects after ${sample.rejectionAfterMs} ms and keeps its worker, which runs the next job; guest CPU is unobservable without shared memory`,
  };
}

/** The isolated page's headers: cross-origin isolation (COOP and COEP). */
export const isolationHeaders: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};
