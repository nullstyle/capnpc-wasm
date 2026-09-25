// The stall ledger of the recovery soak (test.ts) and the termination
// acceptance (termination.ts). A soak recovery that stalls, or a termination
// probe worker that does not start, is tolerated only when its evidence points
// at the engine and a retry passes, and only within one budget per CI job.
// Every driver process of a job (each engine, the suite run and every soak
// round) appends its tolerated stalls to one JSON-lines file under build/test
// and counts the job's entries there, so the budget spans the whole job. CI
// jobs start from a clean checkout; locally the ledger persists until
// `mise run clean:test`. run.ts prints the stalls recorded during its run,
// with a GitHub warning annotation on CI.

/** A tolerated stall, as the ledger and the receipt record it. */
export interface SoakStall {
  /** The CI job the stall counts against (see stallJob). */
  job: string;
  engine: string;
  os: string;
  /** "termination": a probe worker's start stall; absent: a soak recovery. */
  kind?: "termination";
  /** The soak cycle; absent for a termination stall. */
  cycle?: number;
  /** The soak's cancellation, or the termination sample's label. */
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
  return stall.kind === "termination"
    ? "Worker start stall"
    : "Soak recovery stall";
}

/** Where the stall happened: the soak cycle, or the termination sample. */
export function stallPlace(stall: SoakStall): string {
  return stall.kind === "termination"
    ? stall.mode
    : `cycle ${stall.cycle} (${stall.mode})`;
}

/** A GitHub Actions warning annotation for one stall. */
export function stallWarning(stall: SoakStall): string {
  const escape = (text: string) =>
    text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  return `::warning title=${stallTitle(stall)} (${stall.engine})::${
    escape(`${stallPlace(stall)}: ${stall.summary}`)
  }`;
}
