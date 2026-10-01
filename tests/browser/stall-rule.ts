// The stall rule for every browser driver step (test.ts) that creates,
// initializes, or first uses SDK workers (row 140): the SDK client's load,
// the conformance setup and its worker and Studio rows, the feature-corpus
// worker rows, the resource limits, the hostile guests, and the recovery
// soak's client. The recovery soak's cycles and the termination acceptance
// keep their own retries (test.ts, termination.ts) and the same judgement.
//
// A step stalls when it fails with an SDK TimeoutError, when the driver's
// step deadline passes (no progress within its bound), or when a step whose
// result can show a timeout (a conformance row) shows one its expectation
// does not accept, or one from a worker that never initialized. The page
// then reports the evidence (stepStallEvidence): the latest message it posted
// during the step that no reply answered, that worker's facts and trace
// (worker-trace.ts), and the engine health checks. judgeStall() reads it. A
// stall that points at the engine is recorded (an OBSERVED line and a ledger
// entry, soak-stalls.ts, against the same budget per CI job as the soak and
// the termination acceptance) and the step runs once more on a fresh page. A
// stall that points at the SDK or shows only slowness, a page that cannot
// report its evidence, a second stall, or a stall beyond the budget fails the
// step with the evidence. Every assertion about what the SDK does stays with
// the step: the rule only excuses a stall the evidence attributes to the
// engine.
//
// The retry faces the same client history as the stalled attempt. A step
// that creates its own clients is its own unit. A step on a client that
// earlier steps used (a feature row on the page's worker client, a
// conformance row on its surface's cached client or the Studio adapter)
// passes its history, which the fresh page replays first: the rows that ran
// on that client before it. A fault that history causes, however the first
// stall was judged, then recurs on the retry and fails it as a second stall.
// The judgement does not depend on the retry for that: an engine verdict
// rests only on what the engine failed to do for the stalled message (run a
// worker's script, deliver a message to a worker idle since its latest
// activity, deliver a reply, finish a Wasm compile or instantiation), each
// without progress for the floor; whatever the worker's own code did (a
// callback still holding its thread, no return to its event loop, closing
// itself, a post to a busy or terminated worker, an unanswered message, a
// reply the client did not use) points at the SDK. The floor is stallFloorMs,
// or three quarters of a shorter step deadline that caught the stall.
import {
  type EngineHealth,
  judgeStall,
  type PageTracer,
  type PageWorkers,
  type StallEvidence,
  stallFloorFor,
  verdictWords,
} from "./worker-trace.ts";

type Evaluate = <T, A>(
  fn: (argument: A) => Promise<T> | T,
  argument: A,
  label: string,
  ms?: number,
) => Promise<T>;

/** The evidence for a stalled step, as the page reports it. */
export interface StepStallEvidence extends StallEvidence {
  /** The stalled worker's index in the page's tracer; null when no message went unanswered. */
  worker: number | null;
  /** How many messages the page posted during the step. */
  posted: number;
}

/**
 * A page function: the evidence for a step that stalled. The worker is the
 * one the page posted its latest unanswered message to during the step (a
 * reply that reached the page answers a message, by the worker's facts). Its
 * facts and events are copied, and the time taken, before the health checks
 * run, since those start workers of their own. With nothing unanswered, the
 * events are those of the last worker the step posted to.
 */
export async function stepStallEvidence(
  { since, error }: { since: number; error: string },
): Promise<StepStallEvidence> {
  const scope = globalThis as unknown as {
    capnpTracer?: PageTracer;
    capnpEngineHealth?: () => Promise<EngineHealth>;
  };
  const tracer = scope.capnpTracer;
  if (!tracer || !scope.capnpEngineHealth) {
    throw new Error("the page has no worker tracer or health checks");
  }
  const posts = tracer.posts.slice(since);
  let stalled: { worker: number; post: string } | undefined;
  for (const entry of posts) {
    const id = entry.post.slice(entry.post.indexOf(":") + 1);
    const facts = tracer.workers[entry.worker]?.facts;
    if (!facts || facts.pageReplies[id] === undefined) stalled = entry;
  }
  const shown = stalled ?? posts.at(-1);
  const worker = shown ? tracer.workers[shown.worker] : undefined;
  const at = performance.now();
  const facts = stalled && worker
    ? JSON.parse(JSON.stringify(worker.facts))
    : null;
  const events = worker ? [...worker.events] : [];
  // Counted before the health checks start workers of their own.
  const page = (globalThis as unknown as {
    capnpPageWorkers?: () => PageWorkers;
  }).capnpPageWorkers?.();
  const health = await scope.capnpEngineHealth();
  return {
    expected: stalled ? stalled.post : null,
    error,
    events,
    health,
    count: null,
    facts,
    at,
    answered: stalled === undefined && posts.length > 0,
    page,
    worker: stalled ? stalled.worker : null,
    posted: posts.length,
  };
}

/**
 * The error text judgeStall() reads, when a step's failure is a stall: an SDK
 * TimeoutError the page threw, or the driver's step deadline, which counts as
 * a TimeoutError of no progress. null for any other failure.
 */
export function stallErrorText(error: unknown): string | null {
  if (error instanceof Error && error.name === "DeadlineError") {
    return `TimeoutError: no progress: ${error.message}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = /^page\.evaluate: (TimeoutError: [^\n]*)/.exec(message);
  return match ? match[1] : null;
}

/**
 * The floor a stall is judged with: one scaled to the step's deadline when
 * that deadline caught it (stallFloorFor), the default otherwise.
 */
export function stallFloorOf(error: unknown): number | undefined {
  return error instanceof Error && error.name === "DeadlineError" &&
      typeof (error as { ms?: unknown }).ms === "number"
    ? stallFloorFor((error as unknown as { ms: number }).ms)
    : undefined;
}

/** What the rule needs from the driver. */
export interface StallRuleHost {
  /** Evaluate on the page the step runs on now. */
  evaluate: Evaluate;
  /** Replace that page with a fresh one, its prerequisites replayed. */
  freshPage(label: string): Promise<void>;
  /**
   * Record an engine stall: print the OBSERVED line and append the ledger
   * entry. Throws when the stall exceeds the job's budget.
   */
  tolerate(
    kind: string,
    label: string,
    evidence: StepStallEvidence,
    because: string,
  ): Promise<void>;
  /** Arm the page for an attempt (CAPNP_BROWSER_WORKER_STALL), and disarm it after. */
  beforeAttempt?(label: string): Promise<void>;
  afterAttempt?(label: string): Promise<void>;
}

type Attempt<T> =
  | { result: T; stall?: undefined }
  | {
    stall: string;
    since: number;
    floorMs: number | undefined;
    replaying: boolean;
  };

/**
 * Run a step under the stall rule. `kind` names the step in the ledger, and
 * `classify` turns a result that shows a stall into its TimeoutError text.
 * `history` replays what the step's clients did before it, for a step that
 * uses a client earlier steps used: the retry then faces the same client
 * history as the stalled attempt, so a fault that history causes recurs and
 * fails as a second stall. A step that creates its own clients needs none.
 */
export async function underStallRule<T>(
  host: StallRuleHost,
  kind: string,
  label: string,
  attempt: () => Promise<T>,
  classify?: (result: T) => string | null,
  history?: () => Promise<unknown>,
): Promise<T> {
  const run = async (replay: boolean): Promise<Attempt<T>> => {
    if (replay && history) {
      try {
        await history();
      } catch (error) {
        const stall = stallErrorText(error);
        if (stall === null) throw error;
        return {
          stall,
          since: 0,
          floorMs: stallFloorOf(error),
          replaying: true,
        };
      }
    }
    const since = await host.evaluate(
      () => {
        const tracer = (globalThis as unknown as { capnpTracer?: PageTracer })
          .capnpTracer;
        if (!tracer) throw new Error("the page has no worker tracer");
        return tracer.posts.length;
      },
      undefined,
      `${label}: mark the page's messages`,
    );
    await host.beforeAttempt?.(label);
    try {
      const result = await attempt();
      const stall = classify?.(result) ?? null;
      return stall === null
        ? { result }
        : { stall, since, floorMs: undefined, replaying: false };
    } catch (error) {
      const stall = stallErrorText(error);
      if (stall === null) throw error;
      return { stall, since, floorMs: stallFloorOf(error), replaying: false };
    } finally {
      await host.afterAttempt?.(label);
    }
  };
  const first = await run(false);
  if (first.stall === undefined) return first.result;
  let evidence: StepStallEvidence;
  try {
    evidence = await host.evaluate(
      stepStallEvidence,
      { since: first.since, error: first.stall },
      `${label}: gather stall evidence`,
    );
  } catch (error) {
    throw new Error(
      `${label}: the step stalled (${first.stall}), and the page did not report its evidence: ${
        (error as Error).message
      }`,
      { cause: error },
    );
  }
  const { suspect, because } = judgeStall(evidence, {
    floorMs: first.floorMs,
  });
  if (suspect !== "engine") {
    throw new Error(
      `${label}: the step stalled (${first.stall}), and the evidence ${
        verdictWords(suspect)
      }: ${because}: ${JSON.stringify(evidence)}`,
    );
  }
  await host.tolerate(kind, label, evidence, because);
  await host.freshPage(label);
  const second = await run(true);
  if (second.stall !== undefined) {
    throw new Error(
      `${label}: the step stalled again on a fresh page${
        second.replaying ? ", while it replayed its clients' history" : ""
      } (${second.stall}), after a stall that pointed at the engine (${because}): ${
        JSON.stringify(evidence)
      }`,
    );
  }
  return second.result;
}

/**
 * One entry of CAPNP_BROWSER_WORKER_STALL: stall the next SDK worker in the
 * next `remaining` attempts of a step whose label contains `text`, so that it
 * never runs its script (`start`) or never receives a message after init
 * (`job`), as an engine stall would, or so that it never answers (`silent`),
 * as an SDK fault would.
 */
export interface WorkerStallDrill {
  text: string;
  mode: "start" | "job" | "silent";
  remaining: number;
}

/**
 * Parse CAPNP_BROWSER_WORKER_STALL: comma-separated `<label text>` entries,
 * each optionally followed by `=start` (the default), `=job` or `=silent`,
 * and by `*<attempts>` (1 by default).
 */
export function parseWorkerStallDrill(
  value: string | undefined,
): WorkerStallDrill[] {
  if (value === undefined || value.trim() === "") return [];
  return value.split(",").map((entry) => {
    const match =
      /^\s*([^=*]+?)\s*(?:=\s*(start|job|silent)\s*)?(?:\*\s*(\d+)\s*)?$/
        .exec(entry);
    if (!match || Number(match[3] ?? "1") < 1) {
      throw new TypeError(
        `CAPNP_BROWSER_WORKER_STALL entries are <label text>[=start|job|silent][*<attempts>], not ${
          JSON.stringify(entry)
        }`,
      );
    }
    return {
      text: match[1],
      mode: (match[2] ?? "start") as WorkerStallDrill["mode"],
      remaining: Number(match[3] ?? "1"),
    };
  });
}
