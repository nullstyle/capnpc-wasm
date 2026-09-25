// Termination acceptance (TST-04, GAP2-V1): does SDK cancellation stop a
// running Wasm guest in this engine? A probe worker script wraps the SDK's own
// worker.js and patches WebAssembly.instantiate in the worker scope, so the
// whole SDK path runs (client, worker protocol, WASI start) while the guest
// counts its progress in shared memory the page reads. Two guests:
//
//   pure  The probe instantiates spin-counter.wat in place of the job's
//         module: an atomic increment of a shared page in a loop that never
//         leaves Wasm, like a guest stuck computing (GAP2-V1's case).
//   host  The job's own module, spin-yield.wat, calls WASI sched_yield on
//         every iteration; the probe counts the calls. An engine that stops a
//         terminated worker only when it next enters JavaScript stops this
//         guest but not the pure one.
//
// Under cross-origin isolation (COOP/COEP) the counter is a shared Wasm
// memory, which keeps counting whether or not the worker's message port is
// open after terminate(). Without isolation there is no shared memory: only
// the rejection and the terminate() call can be observed.
import type { Engine } from "./engines.ts";

/**
 * Milliseconds a guest may keep running after its job was cancelled. Chromium
 * stops a terminated worker's Wasm after about 2.1 s (GAP2-V3, measured idle);
 * five times that is 10.5 s, rounded up. Every engine shares the bound.
 */
export const terminationBoundMs = 12_000;

/** A counter that has not moved for this long has stopped. */
export const quietMs = 1_000;

/** The SDK deadline for the timeout case. */
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
 * its counter. __GUEST__ is "pure" or "host"; __COUNTER_MODULE__ is the bytes
 * of spin-counter.wat.
 */
const probeWorkerTemplate = `import "__REAL_WORKER_URL__";
const guest = "__GUEST__";
const counterModule = new Uint8Array(__COUNTER_MODULE__);
let memory = null;
let counter = null;
try {
  memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  counter = new Int32Array(memory.buffer);
} catch {
  memory = null;
  counter = null;
}
const instantiate = WebAssembly.instantiate;
WebAssembly.instantiate = function (source, imports) {
  const wasi = imports && imports.wasi_snapshot_preview1;
  if (counter && wasi) {
    if (guest === "pure") {
      return WebAssembly.compile(counterModule).then((module) =>
        instantiate.call(WebAssembly, module, { env: { memory } })
      );
    }
    if (typeof wasi.sched_yield === "function") {
      const inner = wasi.sched_yield;
      wasi.sched_yield = function () {
        Atomics.add(counter, 0, 1);
        return inner.apply(this, arguments);
      };
    }
  }
  return instantiate.call(WebAssembly, source, imports);
};
try {
  self.postMessage({ kind: "capnpProbe", counter: memory ? memory.buffer : null });
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
  atRejection: number | null;
  final: number | null;
  rejection: { name: string; message: string };
  /** Milliseconds from the job's start until it rejected. */
  rejectionAfterMs: number;
  /** Milliseconds from the rejection until the counter last moved; null when it kept moving for the whole bound. */
  stoppedAfterMs: number | null;
  terminateCalls: number;
  workersCreated: number;
}

export interface TerminationResult {
  engine: Engine;
  crossOriginIsolated: boolean;
  boundMs: number;
  samples: TerminationSample[];
  /** Set when the engine is recorded as an expected failure, with the reason. */
  expectedFailure?: string;
  verdict: string;
}

/**
 * Why WebKit may keep the pure guest running: WebKit never stops a Wasm loop
 * on Worker.terminate() (GAP2-V1). Decision D1 = A has T08's in-guest
 * interruption stop it; until that lands the pure guest is an expected
 * failure. The expectation is strict: the test fails as soon as WebKit stops
 * the guest, which is the signal to remove this expectation with T08.
 */
export const webkitExpectedFailure =
  "D1 = A: stopped by T08's in-guest interruption (GAP2-V1); remove this expectation when T08 lands";

type Evaluate = <T, A>(
  fn: (argument: A) => Promise<T> | T,
  argument: A,
  label: string,
) => Promise<T>;

/**
 * Prepare a termination page: load the SDK, build the two probe workers
 * around the real worker.js, and keep the job's module. Runs while the asset
 * server is still up; everything later runs from memory.
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
        .replace("__GUEST__", guest)
        .replace("__COUNTER_MODULE__", JSON.stringify(counterModule));
      probeURLs[guest] = URL.createObjectURL(
        new Blob([source], { type: "text/javascript" }),
      );
    }
    (globalThis as unknown as { capnpTermination: unknown }).capnpTermination =
      { sdk, modules: { compiler: spinGuest, generators: {} }, probeURLs };
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
    async ({ guest, mode, timeoutMs, boundMs, quietMs }) => {
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
          modules: unknown;
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
        state.modules,
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
      const countBeforeCancel = read();
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
        while (performance.now() - rejectedAt < boundMs) {
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
      if (mode !== "dispose") client.dispose();
      return {
        guest,
        mode,
        hasCounter: counter !== null,
        countBeforeCancel,
        atRejection,
        final: read(),
        rejection,
        rejectionAfterMs: Math.round(rejectedAt - started),
        stoppedAfterMs,
        terminateCalls: audit.terminated - terminatedBefore,
        workersCreated: audit.created - createdBefore,
      };
    },
    { guest, mode, timeoutMs, boundMs: terminationBoundMs, quietMs },
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
 * The cross-origin-isolated acceptance: after a timeout, an abort, and a
 * dispose, both guests' counters stop within the bound. WebKit's pure-Wasm
 * guest is recorded as an expected failure (webkitExpectedFailure) and must
 * keep failing; WebKit's host-calling guest is recorded without a bound.
 */
export async function checkIsolatedTermination(
  engine: Engine,
  evaluate: Evaluate,
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
        sample.terminateCalls === 1 && sample.workersCreated === 1,
        `${label}: ${sample.workersCreated} workers created and ${sample.terminateCalls} terminated, expected one each`,
      );
    }
  }
  const pure = samples.filter((sample) => sample.guest === "pure");
  const host = samples.filter((sample) => sample.guest === "host");
  const summary = `pure Wasm: ${describe(pure)}; host calls: ${describe(host)}`;
  if (engine === "webkit") {
    const stopped = pure.filter((sample) => sample.stoppedAfterMs !== null);
    assert(
      stopped.length === 0,
      `${engine}: the pure-Wasm guest stopped after ${
        stopped.map((sample) => sample.mode).join(", ")
      } (${summary}), so the expected failure no longer holds (${webkitExpectedFailure}): drop the WebKit branch in checkIsolatedTermination and assert the bound for WebKit as for the other engines`,
    );
    return {
      engine,
      crossOriginIsolated: true,
      boundMs: terminationBoundMs,
      samples,
      expectedFailure: webkitExpectedFailure,
      verdict:
        `EXPECTED FAILURE ${engine}: the pure-Wasm guest kept running after every cancellation (${webkitExpectedFailure}); ${summary}`,
    };
  }
  const running = samples.filter((sample) => sample.stoppedAfterMs === null);
  assert(
    running.length === 0,
    `${engine}: a guest kept running past the ${terminationBoundMs} ms bound (${summary})`,
  );
  return {
    engine,
    crossOriginIsolated: true,
    boundMs: terminationBoundMs,
    samples,
    verdict:
      `PASS ${engine}: timeout, abort, and dispose stop both guests within ${terminationBoundMs} ms (${summary})`,
  };
}

/**
 * Without cross-origin isolation the engine offers no shared memory, so guest
 * CPU cannot be observed: the timeout must still reject within its deadline
 * and terminate exactly one worker.
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
  assert(
    sample.rejection.name === "TimeoutError",
    `${engine}: rejected with ${sample.rejection.name} (${sample.rejection.message}), expected TimeoutError`,
  );
  assert(
    sample.rejectionAfterMs < timeoutMs + 5_000,
    `${engine}: the timeout rejected after ${sample.rejectionAfterMs} ms`,
  );
  assert(
    sample.terminateCalls === 1 && sample.workersCreated === 1,
    `${engine}: ${sample.workersCreated} workers created and ${sample.terminateCalls} terminated, expected one each`,
  );
  return {
    engine,
    crossOriginIsolated: false,
    boundMs: terminationBoundMs,
    samples: [sample],
    verdict:
      `PASS ${engine}: without cross-origin isolation the timeout rejects after ${sample.rejectionAfterMs} ms and terminates its worker${
        sample.hasCounter
          ? sample.stoppedAfterMs === null
            ? "; the guest kept running"
            : `; the guest stopped after ${sample.stoppedAfterMs} ms`
          : "; guest CPU is unobservable without shared memory"
      }`,
  };
}

/** The isolated page's headers: cross-origin isolation (COOP and COEP). */
export const isolationHeaders: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};
