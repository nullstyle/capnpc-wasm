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
import type { Engine } from "./engines.ts";
import { settleGraceMs } from "../../sdk/typescript/interrupt.ts";

/**
 * Milliseconds a guest may keep running after its job was cancelled. The
 * SDK's in-guest checks stop a guest within a millisecond of the cancellation
 * (measured idle in Chromium and WebKit); the page samples the counter every
 * 50 ms, so it observes stops of 0 to about 50 ms. The bound is forty times
 * that sampling interval, for loaded CI hosts, and every engine shares it.
 * The page watches the counter for the bound plus `quietMs` after the
 * rejection, so a guest that stops just inside the bound is still seen to
 * stop, and the check requires its last movement within the bound.
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

/** The SDK deadline for the timeout case, and for the follow-up job. */
export const timeoutMs = 300;

export type TerminationGuest = "pure" | "host";
export type TerminationMode = "timeout" | "abort" | "dispose";

/**
 * Installed in every termination context before its page loads: counts the
 * workers the SDK creates and terminates, and collects the counter each probe
 * worker posts before it handles any message.
 */
export const workerAuditScript = `(() => {
  const RealWorker = globalThis.Worker;
  const audit = globalThis.capnpWorkerAudit = { created: 0, terminated: 0, probes: [] };
  globalThis.Worker = class extends RealWorker {
    constructor(...args) {
      super(...args);
      audit.created++;
      this.addEventListener("message", (event) => {
        const data = event.data;
        if (data && data.kind === "capnpProbe") {
          audit.probes.push(data.counter ? new Int32Array(data.counter) : null);
        }
      });
    }
    terminate() {
      audit.terminated++;
      super.terminate();
    }
  };
})();`;

/**
 * The probe worker script: a module worker that statically imports the real
 * worker.js (a blob URL substituted in), so the SDK's message handler exists
 * before any message arrives, then patches WebAssembly.instantiate and posts
 * its counter. __GUEST__ is "pure" or "host": the import whose calls count.
 */
const probeWorkerTemplate = `import "__REAL_WORKER_URL__";
const guest = "__GUEST__";
let counter = null;
try {
  counter = new Int32Array(new SharedArrayBuffer(4));
} catch {
  counter = null;
}
const instantiate = WebAssembly.instantiate;
WebAssembly.instantiate = function (source, imports) {
  const counted = guest === "pure"
    ? [imports && imports.capnp_wasm, "interrupt"]
    : [imports && imports.wasi_snapshot_preview1, "sched_yield"];
  const [namespace, name] = counted;
  if (counter && namespace && typeof namespace[name] === "function") {
    const inner = namespace[name];
    namespace[name] = function () {
      Atomics.add(counter, 0, 1);
      return inner.apply(this, arguments);
    };
  }
  return instantiate.call(WebAssembly, source, imports);
};
try {
  self.postMessage({ kind: "capnpProbe", counter: counter ? counter.buffer : null });
} catch {
  counter = null;
  self.postMessage({ kind: "capnpProbe", counter: null });
}
`;

/** What one cancellation did, as measured in the page. */
export interface TerminationSample {
  guest: TerminationGuest;
  mode: TerminationMode;
  /** Whether the probe could share a counter (cross-origin isolation). */
  hasCounter: boolean;
  /** The counter when the job was cancelled; positive means the guest ran. */
  countBeforeCancel: number | null;
  /**
   * How far the counter moved in one 50 ms sample just before the
   * cancellation. It must be positive: a guest whose counter moves more
   * slowly than the sampling could otherwise read as stopped at once.
   */
  advanceBeforeCancel: number | null;
  atRejection: number | null;
  final: number | null;
  rejection: { name: string; message: string };
  /** Milliseconds from the job's start until it rejected. */
  rejectionAfterMs: number;
  /** Milliseconds from the rejection until the counter last moved; null when it kept moving for the whole bound. */
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
  return await evaluate(async ({ spinGuest, template, counterModule }) => {
    const sdk = await import(new URL("/sdk/mod.js", location.href).href);
    const workerSource = await (await fetch("/sdk/worker.js")).text();
    const realURL = URL.createObjectURL(
      new Blob([workerSource], { type: "text/javascript" }),
    );
    const probeURLs: Record<string, string> = {};
    for (const guest of ["pure", "host"]) {
      const source = template
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
    counterModule: Array.from(counterModule),
  }, label);
}

/** Cancel a spinning guest one way and watch the shared counter afterwards. */
export async function measureTermination(
  evaluate: Evaluate,
  guest: TerminationGuest,
  mode: TerminationMode,
  label: string,
): Promise<TerminationSample> {
  return await evaluate(
    async ({ guest, mode, timeoutMs, boundMs, quietMs, graceMs }) => {
      type Client = {
        compile(
          job: unknown,
          options?: { signal?: AbortSignal; timeoutMs?: number },
        ): Promise<unknown>;
        dispose(): void;
      };
      const state = (globalThis as unknown as {
        capnpTermination: {
          sdk: {
            createWorkerCompiler(
              url: string,
              modules: unknown,
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
        };
      }).capnpWorkerAudit;
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms));
      const probesBefore = audit.probes.length;
      const terminatedBefore = audit.terminated;
      const createdBefore = audit.created;
      const client = await state.sdk.createWorkerCompiler(
        state.probeURLs[guest],
        state.modules[guest],
      );
      // The probe posts its counter before it handles the init message, so
      // the counter arrives before the factory resolves.
      const counter = audit.probes[probesBefore] ?? null;
      // Unsigned: a guest that is never stopped keeps counting for the rest
      // of the run.
      const read = () => counter ? Atomics.load(counter, 0) >>> 0 : null;
      const job = {
        files: { "a.capnp": "" },
        entrypoints: ["a.capnp"],
        generators: [],
      };
      const started = performance.now();
      const controller = new AbortController();
      const pending = mode === "timeout"
        ? client.compile(job, { timeoutMs })
        : mode === "abort"
        ? client.compile(job, { signal: controller.signal })
        : client.compile(job);
      // Cancel only once the guest is running (the counter moves), or after
      // a moment when no counter can show that.
      const runningDeadline = performance.now() + 10_000;
      if (counter) {
        while (read() === 0 && performance.now() < runningDeadline) {
          await sleep(10);
        }
      } else await sleep(100);
      const sampled = read();
      if (counter) await sleep(50);
      const countBeforeCancel = read();
      const advanceBeforeCancel = counter
        ? countBeforeCancel! - sampled!
        : null;
      if (mode === "abort") controller.abort();
      if (mode === "dispose") client.dispose();
      let rejection: { name: string; message: string };
      try {
        await pending;
        rejection = { name: "resolved", message: "the job completed" };
      } catch (error) {
        rejection = {
          name: (error as Error).name,
          message: String((error as Error).message).slice(0, 120),
        };
      }
      const rejectedAt = performance.now();
      const atRejection = read();
      let last = atRejection;
      let lastChange = rejectedAt;
      let stoppedAfterMs: number | null = null;
      if (counter) {
        while (performance.now() - rejectedAt < boundMs + quietMs) {
          await sleep(50);
          const now = performance.now();
          const value = read();
          if (value !== last) {
            last = value;
            lastChange = now;
          } else if (now - lastChange >= quietMs) {
            stoppedAfterMs = Math.max(0, Math.round(lastChange - rejectedAt));
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
          await client.compile(job, { timeoutMs });
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
        guest,
        mode,
        hasCounter: counter !== null,
        countBeforeCancel,
        atRejection,
        final,
        rejection,
        rejectionAfterMs: Math.round(rejectedAt - started),
        advanceBeforeCancel,
        stoppedAfterMs,
        followUp,
        terminateCalls,
        workersCreated,
      };
    },
    {
      guest,
      mode,
      timeoutMs,
      boundMs: terminationBoundMs,
      quietMs,
      graceMs: clientGraceMs,
    },
    label,
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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
 * bound, and the worker survives the timeout and the abort.
 */
export async function checkIsolatedTermination(
  engine: Engine,
  evaluate: Evaluate,
  os: string = Deno.build.os,
): Promise<TerminationResult> {
  const samples: TerminationSample[] = [];
  for (const guest of ["pure", "host"] as const) {
    for (const mode of ["timeout", "abort", "dispose"] as const) {
      const sample = await measureTermination(
        evaluate,
        guest,
        mode,
        `${engine} isolated termination ${guest} ${mode}`,
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
 * follow-up job then runs on the same worker and times out in its turn.
 */
export async function checkPlainTermination(
  engine: Engine,
  evaluate: Evaluate,
): Promise<TerminationResult> {
  const sample = await measureTermination(
    evaluate,
    "pure",
    "timeout",
    `${engine} plain termination timeout`,
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
