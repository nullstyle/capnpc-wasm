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
// does not accept. The page then reports the evidence (stepStallEvidence):
// the latest message it posted during the step that its worker never
// answered, that worker's trace (worker-trace.ts), and the engine health
// checks. judgeStall() reads it. A stall that points at the engine is
// recorded (an OBSERVED line and a ledger entry, soak-stalls.ts, against the
// same budget per CI job as the soak and the termination acceptance) and the
// step runs once more on a fresh page. A stall that points at the SDK, a page
// that cannot report its evidence, a second stall, or a stall beyond the
// budget fails the step with the evidence. Every assertion about what the SDK
// does stays with the step: the rule only excuses a stall the evidence
// attributes to the engine.
import {
  type EngineHealth,
  judgeStall,
  type PageTracer,
  type StallEvidence,
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
 * reply that reached the page answers a message); its events are copied
 * before the health checks run, since those start workers of their own.
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
  let stalled: { worker: number; post: string } | undefined;
  for (const entry of tracer.posts.slice(since)) {
    const id = entry.post.slice(entry.post.indexOf(":") + 1);
    const events = tracer.workers[entry.worker]?.events ?? [];
    if (!events.includes(`page:reply:${id}`)) stalled = entry;
  }
  const events = stalled ? [...tracer.workers[stalled.worker].events] : [];
  const posted = tracer.posts.length - since;
  const health = await scope.capnpEngineHealth();
  return {
    expected: stalled ? stalled.post : null,
    error,
    events,
    health,
    count: null,
    worker: stalled ? stalled.worker : null,
    posted,
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
  | { stall: string; since: number };

/**
 * Run a step under the stall rule. `kind` names the step in the ledger, and
 * `classify` turns a result that shows a stall into its TimeoutError text.
 */
export async function underStallRule<T>(
  host: StallRuleHost,
  kind: string,
  label: string,
  attempt: () => Promise<T>,
  classify?: (result: T) => string | null,
): Promise<T> {
  const run = async (): Promise<Attempt<T>> => {
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
      return stall === null ? { result } : { stall, since };
    } catch (error) {
      const stall = stallErrorText(error);
      if (stall === null) throw error;
      return { stall, since };
    } finally {
      await host.afterAttempt?.(label);
    }
  };
  const first = await run();
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
  const { suspect, because } = judgeStall(evidence);
  if (suspect !== "engine") {
    throw new Error(
      `${label}: the step stalled (${first.stall}), and the evidence points at the SDK: ${because}: ${
        JSON.stringify(evidence)
      }`,
    );
  }
  await host.tolerate(kind, label, evidence, because);
  await host.freshPage(label);
  const second = await run();
  if (second.stall !== undefined) {
    throw new Error(
      `${label}: the step stalled again on a fresh page (${second.stall}), after a stall that pointed at the engine (${because}): ${
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
