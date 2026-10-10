// The stall ledger of the browser driver (test.ts): the recovery soak, the
// termination acceptance (termination.ts), and every other step that creates
// or first uses SDK workers (stall-rule.ts). A stall is tolerated only when
// its evidence points at the engine, and only within one budget per CI job;
// the step is retried once and recorded after its retry returns without a
// stall. Every driver process
// of a job (each engine, the suite run and every soak round) appends its
// tolerated stalls to one JSON-lines file under build/test and counts the
// job's entries there, so the budget spans the whole job. CI jobs start from a
// clean checkout; locally the ledger persists until `mise run clean:test`.
// run.ts prints the stalls recorded during its run, with a GitHub warning
// annotation on CI.

/**
 * The driver steps the stall rule covers (stall-rule.ts), each a stall kind:
 * the main page's SDK clients, the conformance runner and the primed Studio
 * adapter, the feature-corpus worker rows, the worker resource limits, the
 * worker hostile guests, the recovery soak's client, and the browser-worker
 * and Studio conformance rows.
 */
export type StallStep =
  | "sdk-client"
  | "conformance-setup"
  | "feature-rows"
  | "resource-limits"
  | "hostile-guests"
  | "soak-client"
  | "conformance-rows";

/** A tolerated stall, as the ledger and the receipt record it. */
export interface SoakStall {
  /** The CI job the stall counts against (see stallJob). */
  job: string;
  engine: string;
  os: string;
  /**
   * What stalled: absent for a soak recovery, "termination" for a probe
   * worker's start in the termination acceptance, and otherwise the step the
   * stall rule ran.
   */
  kind?: "termination" | StallStep;
  /** The soak cycle; absent for any other stall. */
  cycle?: number;
  /** The soak's cancellation, or the stalled sample's or step's label. */
  mode: string;
  /** ISO time of the record. */
  at: string;
  /** One line: the error, the stalled worker's last event, the health checks. */
  summary: string;
  /** The page's full record: both workers' traces and the health checks. */
  detail: unknown;
}

export const stallLedgerPath = "build/test/soak-stalls.jsonl";

/** The current CI job's key, or "local" outside GitHub Actions. */
export function stallJob(): string {
  const env = (name: string) => Deno.env.get(name) ?? "";
  return env("GITHUB_ACTIONS")
    ? `${env("GITHUB_RUN_ID")}.${env("GITHUB_RUN_ATTEMPT")}.${
      env("GITHUB_JOB")
    }`
    : "local";
}

/** CAPNP_SOAK_STALL_BUDGET: stalls tolerated per job; 1 by default, 0 is strict. */
export function stallBudget(): number {
  const text = Deno.env.get("CAPNP_SOAK_STALL_BUDGET");
  if (text === undefined || text === "") return 1;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `CAPNP_SOAK_STALL_BUDGET must be a non-negative integer, not ${
        JSON.stringify(text)
      }`,
    );
  }
  return value;
}

export async function readStalls(
  path = stallLedgerPath,
): Promise<SoakStall[]> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  return text.split("\n").filter((line) => line.trim()).map((line) =>
    JSON.parse(line) as SoakStall
  );
}

/**
 * Append a stall to the ledger as one line (a single append, so drivers that
 * run at once cannot interleave records) and return how many stalls the
 * ledger now holds for the stall's job.
 */
export async function recordStall(
  stall: SoakStall,
  path = stallLedgerPath,
): Promise<number> {
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, `${JSON.stringify(stall)}\n`, {
    append: true,
  });
  return (await readStalls(path)).filter((entry) => entry.job === stall.job)
    .length;
}

/** What kind of stall this was, as a title. */
export function stallTitle(stall: SoakStall): string {
  return stall.kind === undefined
    ? "Soak recovery stall"
    : stall.kind === "termination"
    ? "Worker start stall"
    : "Worker stall";
}

/** Where the stall happened: the soak cycle, the termination sample, or the step. */
export function stallPlace(stall: SoakStall): string {
  return stall.kind === undefined
    ? `cycle ${stall.cycle} (${stall.mode})`
    : stall.kind === "termination"
    ? stall.mode
    : `${stall.mode} (${stall.kind})`;
}

/** A GitHub Actions warning annotation for one stall. */
export function stallWarning(stall: SoakStall): string {
  const escape = (text: string) =>
    text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  return `::warning title=${stallTitle(stall)} (${stall.engine})::${
    escape(`${stallPlace(stall)}: ${stall.summary}`)
  }`;
}
