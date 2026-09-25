// Recompute the nightly-confidence ledger,
// docs/release-evidence/nightly-confidence.json (decision D5 = A): the streak
// of consecutive successful scheduled runs of this repository's nightly
// workflow at the ref/capnp-zig revision the index pins. The gitlink is read
// on every run, never from the ledger, so a reference bump restarts the count.
// Run and gitlink data come from the GitHub Actions API through `gh api`,
// read-only (a local run uses the gh login; CI sets GH_TOKEN).
//
// Usage: deno run --allow-read --allow-run=git,gh --allow-write=docs/release-evidence
//          scripts/audit-nightly.ts [--repo owner/name] [--workflow nightly.yml] [--check]
//
// The computed fields are rewritten; requiredConsecutiveScheduledRuns, rules,
// publicationAuthorized, and supersedes keep their committed values. --check
// writes nothing and exits 1 when the committed ledger differs from the
// computed one. Until the workflow has a completed scheduled run on GitHub, the
// ledger records status "no_scheduled_runs" and a streak of 0; that is a
// result, not an error. scripts/check-evidence.ts applies ledgerProblems to the
// committed ledger offline.

const ledgerPath = "docs/release-evidence/nightly-confidence.json";
const ledgerName = "nightly-confidence.json";
const nativeReference = "ref/capnp-zig";
const commitPattern = /^[0-9a-f]{40}$/;

/** The fields of a workflow run this script reads from the API. */
export type Run = {
  id: number;
  run_attempt: number;
  event: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  created_at: string;
  html_url: string;
};

export type Cycle = {
  scheduledDateUtc: string;
  runId: number;
  runAttempt: number;
  runUrl: string;
  headSha: string;
};

export type StreakEnd = {
  scheduledDateUtc: string;
  kind: "conclusion" | "rerun" | "native_revision" | "missed";
  detail: string;
  runUrl: string | null;
};

export type Streak = { cycles: Cycle[]; streakEnd: StreakEnd | null };

/** The ledger this script writes (schema version 2). */
export type Ledger = {
  schemaVersion: number;
  phase: string;
  workflow: { repository: string; path: string; event: string };
  nativeReference: string;
  nativeRevision: string;
  requiredConsecutiveScheduledRuns: number;
  status: "no_scheduled_runs" | "measured";
  statusDetail: string | null;
  currentConsecutiveScheduledRuns: number;
  firstQualifyingScheduledDateUtc: string | null;
  lastQualifyingScheduledDateUtc: string | null;
  cycles: Cycle[];
  streakEnd: StreakEnd | null;
  rules: string[];
  publicationAuthorized: boolean;
  supersedes: string;
};

export function dayBefore(date: string): string {
  const time = Date.parse(`${date}T00:00:00Z`) - 86_400_000;
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * The current streak, newest cycle first. A cycle is a scheduled run that
 * concluded success on its first attempt at the pinned native revision. The
 * API reports only a run's latest attempt, so any re-run ends the streak, even
 * of a run whose first attempt succeeded. Cycles fall on consecutive UTC
 * dates, the newest on `today` or the day before (today's run may not have
 * happened yet), and a second run on a counted date must qualify too but adds
 * no cycle.
 *
 * Runs that have not completed are never counted. A run in progress dated
 * today leaves the streak to the completed runs before it, so the nightly's
 * own ledger job, which runs inside that run, counts the runs before it. A run
 * in progress dated earlier, such as a re-run, leaves its date without a
 * completed run: the streak ends there, and the detail names the run.
 */
export async function computeStreak(
  runs: readonly Run[],
  pinned: string,
  today: string,
  nativeRevisionOf: (run: Run) => Promise<string>,
): Promise<Streak> {
  const scheduled = runs
    .filter((run) => run.event === "schedule")
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
  const completed = scheduled.filter((run) => run.status === "completed");
  const cycles: Cycle[] = [];
  const end = (
    scheduledDateUtc: string,
    kind: StreakEnd["kind"],
    detail: string,
    runUrl: string | null,
  ): Streak => ({
    cycles,
    streakEnd: { scheduledDateUtc, kind, detail, runUrl },
  });
  const missed = (due: string): Streak => {
    const pending = scheduled.find((other) =>
      other.status !== "completed" && other.created_at.slice(0, 10) === due
    );
    return end(
      due,
      "missed",
      pending
        ? `no completed scheduled run on ${due}; run ${pending.id} (attempt ${pending.run_attempt}) is ${pending.status}`
        : `no completed scheduled run on ${due}`,
      pending?.html_url ?? null,
    );
  };
  let counted: string | undefined;
  for (const run of completed) {
    const date = run.created_at.slice(0, 10);
    const due = dayBefore(counted ?? today);
    if (date !== counted && date < due) return missed(due);
    if (run.conclusion !== "success") {
      return end(
        date,
        "conclusion",
        `run ${run.id} concluded ${run.conclusion ?? "without a conclusion"}`,
        run.html_url,
      );
    }
    if (run.run_attempt !== 1) {
      return end(
        date,
        "rerun",
        `run ${run.id} was re-run (attempt ${run.run_attempt})`,
        run.html_url,
      );
    }
    const revision = await nativeRevisionOf(run);
    if (revision !== pinned) {
      return end(
        date,
        "native_revision",
        `run ${run.id} tested ${nativeReference} ${revision.slice(0, 7)}, not ${
          pinned.slice(0, 7)
        }`,
        run.html_url,
      );
    }
    if (date !== counted) {
      cycles.push({
        scheduledDateUtc: date,
        runId: run.id,
        runAttempt: run.run_attempt,
        runUrl: run.html_url,
        headSha: run.head_sha,
      });
      counted = date;
    }
  }
  // Every completed run is counted; a run in progress older than all of them
  // still leaves the day before the oldest cycle without a completed run.
  const oldest = counted;
  if (
    oldest !== undefined &&
    scheduled.some((other) => other.created_at.slice(0, 10) < oldest)
  ) {
    return missed(dayBefore(oldest));
  }
  return { cycles, streakEnd: null };
}

/**
 * Invariants of a ledger that its schema cannot express: the counters and
 * dates match the cycle list, cycles are first-attempt runs of the ledger's
 * own repository on consecutive dates, newest first, the status agrees with
 * the runs, and nativeRevision is the gitlink the index pins now, so a
 * reference bump without a regenerated ledger fails.
 */
export function ledgerProblems(ledger: Ledger, gitlink: string): string[] {
  const problems: string[] = [];
  const { cycles, streakEnd } = ledger;
  if (ledger.nativeRevision !== gitlink) {
    problems.push(
      `nativeRevision ${ledger.nativeRevision} is not the ${nativeReference} gitlink in the index, ${gitlink}; run mise run audit:nightly`,
    );
  }
  if (ledger.currentConsecutiveScheduledRuns !== cycles.length) {
    problems.push(
      `currentConsecutiveScheduledRuns is ${ledger.currentConsecutiveScheduledRuns} but the ledger lists ${cycles.length} cycles`,
    );
  }
  const oldest = cycles.at(-1)?.scheduledDateUtc ?? null;
  const newest = cycles[0]?.scheduledDateUtc ?? null;
  if (ledger.firstQualifyingScheduledDateUtc !== oldest) {
    problems.push(
      `firstQualifyingScheduledDateUtc is ${ledger.firstQualifyingScheduledDateUtc} but the oldest cycle is ${oldest}`,
    );
  }
  if (ledger.lastQualifyingScheduledDateUtc !== newest) {
    problems.push(
      `lastQualifyingScheduledDateUtc is ${ledger.lastQualifyingScheduledDateUtc} but the newest cycle is ${newest}`,
    );
  }
  const runs = `https://github.com/${ledger.workflow.repository}/actions/runs/`;
  cycles.forEach((cycle, index) => {
    if (cycle.runUrl !== `${runs}${cycle.runId}`) {
      problems.push(
        `cycles[${index}].runUrl ${cycle.runUrl} is not run ${cycle.runId} of ${ledger.workflow.repository}`,
      );
    }
    if (cycle.runAttempt !== 1) {
      problems.push(
        `cycles[${index}] passed on attempt ${cycle.runAttempt}; only first attempts qualify`,
      );
    }
    const previous = cycles[index - 1]?.scheduledDateUtc;
    if (previous && cycle.scheduledDateUtc !== dayBefore(previous)) {
      problems.push(
        `cycles[${index}] is dated ${cycle.scheduledDateUtc}, not ${
          dayBefore(previous)
        }, the day before cycles[${index - 1}]`,
      );
    }
  });
  if (streakEnd) {
    if (streakEnd.runUrl !== null && !streakEnd.runUrl.startsWith(runs)) {
      problems.push(
        `streakEnd.runUrl ${streakEnd.runUrl} is not a run of ${ledger.workflow.repository}`,
      );
    }
    if (
      oldest && streakEnd.scheduledDateUtc !== oldest &&
      streakEnd.scheduledDateUtc !== dayBefore(oldest)
    ) {
      problems.push(
        `streakEnd is dated ${streakEnd.scheduledDateUtc}, not the oldest cycle's date ${oldest} or the day before`,
      );
    }
  }
  if (ledger.status === "no_scheduled_runs") {
    if (cycles.length > 0 || streakEnd !== null) {
      problems.push("status no_scheduled_runs, but the ledger records runs");
    }
    if (ledger.statusDetail === null) {
      problems.push("status no_scheduled_runs needs a statusDetail");
    }
  } else {
    if (ledger.statusDetail !== null) {
      problems.push("status measured takes no statusDetail");
    }
    if (cycles.length === 0 && streakEnd === null) {
      problems.push("status measured, but the ledger records no run");
    }
  }
  if (ledger.supersedes === ledgerName) {
    problems.push("supersedes names the ledger itself");
  }
  return problems;
}

async function output(command: string, args: string[]): Promise<string> {
  const result = await new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${
        new TextDecoder().decode(result.stderr).trim()
      }`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}

/** The ref/capnp-zig gitlink recorded in the index, as scripts/lib/refs.sh reads it. */
export async function indexGitlink(): Promise<string> {
  const lines = (await output("git", [
    "ls-files",
    "--stage",
    "--",
    `:(top)${nativeReference}`,
  ])).trim().split("\n").filter(Boolean);
  const [mode, revision, stage] = lines.length === 1
    ? lines[0].split(/\s+/)
    : [];
  if (mode !== "160000" || stage !== "0" || !commitPattern.test(revision)) {
    throw new Error(
      `no single ${nativeReference} gitlink in the index: ${
        JSON.stringify(lines)
      }`,
    );
  }
  return revision;
}

function usage(message: string): never {
  console.error(message);
  console.error(
    "usage: audit-nightly.ts [--repo owner/name] [--workflow nightly.yml] [--check]",
  );
  Deno.exit(2);
}

function parseArgs(args: string[]) {
  const options = { repo: "nullstyle/capnpc-wasm", workflow: "nightly.yml" };
  let check = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--check") {
      check = true;
    } else if (arg === "--repo" || arg === "--workflow") {
      const value = args[++index];
      if (value === undefined) usage(`${arg} needs a value`);
      options[arg === "--repo" ? "repo" : "workflow"] = value;
    } else {
      usage(`unknown argument ${arg}`);
    }
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo)) {
    usage(`--repo ${options.repo} is not owner/name`);
  }
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(options.workflow)) {
    usage(`--workflow ${options.workflow} is not a workflow file name`);
  }
  return { ...options, check };
}

type HandFields = Pick<
  Ledger,
  | "schemaVersion"
  | "requiredConsecutiveScheduledRuns"
  | "rules"
  | "publicationAuthorized"
  | "supersedes"
>;

/** The hand-maintained fields of the committed ledger. */
function committedFields(text: string): HandFields {
  const ledger = JSON.parse(text) as Partial<HandFields>;
  const problems: string[] = [];
  if (ledger.schemaVersion !== 2) {
    problems.push(
      `schemaVersion ${ledger.schemaVersion} (this script writes 2)`,
    );
  }
  const required = ledger.requiredConsecutiveScheduledRuns;
  if (
    typeof required !== "number" || !Number.isInteger(required) || required < 1
  ) {
    problems.push("requiredConsecutiveScheduledRuns is not a positive integer");
  }
  if (
    !Array.isArray(ledger.rules) ||
    !ledger.rules.every((rule) => typeof rule === "string")
  ) problems.push("rules is not a list of strings");
  if (typeof ledger.publicationAuthorized !== "boolean") {
    problems.push("publicationAuthorized is not a boolean");
  }
  if (typeof ledger.supersedes !== "string") {
    problems.push("supersedes is not a file name");
  }
  if (problems.length > 0) {
    throw new Error(`${ledgerPath}: ${problems.join("; ")}`);
  }
  return ledger as HandFields;
}

if (import.meta.main) {
  const { repo, workflow, check } = parseArgs(Deno.args);
  const workflowPath = `.github/workflows/${workflow}`;
  let committedText: string;
  try {
    committedText = await Deno.readTextFile(ledgerPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    console.error(
      `audit-nightly.ts: ${ledgerPath} not found; run it from the repository root (mise run audit:nightly)`,
    );
    Deno.exit(2);
  }
  const committed = committedFields(committedText);
  const pinned = await indexGitlink();

  const registered = (await output("gh", [
    "api",
    "--paginate",
    `repos/${repo}/actions/workflows?per_page=100`,
    "--jq",
    ".workflows[].path",
  ])).split("\n").map((line) => line.trim());
  const runs: Run[] = registered.includes(workflowPath)
    ? (await output("gh", [
      "api",
      "--paginate",
      `repos/${repo}/actions/workflows/${workflow}/runs?event=schedule&per_page=100`,
      "--jq",
      ".workflow_runs[] | {id, run_attempt, event, status, conclusion, head_sha, created_at, html_url}",
    ])).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Run)
    : [];

  const revisions = new Map<string, Promise<string>>();
  const nativeRevisionOf = (run: Run): Promise<string> => {
    let revision = revisions.get(run.head_sha);
    if (!revision) {
      revision = output("gh", [
        "api",
        `repos/${repo}/contents/${nativeReference}?ref=${run.head_sha}`,
        "--jq",
        "[.type, .sha] | @tsv",
      ]).then((text) => {
        const [type, sha] = text.trim().split("\t");
        if (type !== "submodule" || !commitPattern.test(sha ?? "")) {
          throw new Error(
            `${repo}@${run.head_sha}: ${nativeReference} is not a gitlink (${text.trim()})`,
          );
        }
        return sha;
      });
      revisions.set(run.head_sha, revision);
    }
    return revision;
  };

  const today = new Date().toISOString().slice(0, 10);
  const { cycles, streakEnd } = await computeStreak(
    runs,
    pinned,
    today,
    nativeRevisionOf,
  );
  const completedRuns = runs.filter((run) =>
    run.event === "schedule" && run.status === "completed"
  ).length;
  // One wording whether or not GitHub has registered the file (a push to any
  // branch registers it), so the committed ledger changes only with runs.
  const statusDetail = completedRuns === 0
    ? `no completed scheduled run of ${workflowPath} in ${repo} yet; GitHub schedules the workflow only from the default branch, and the streak starts with its first scheduled run there`
    : null;
  const ledger: Ledger = {
    schemaVersion: 2,
    phase: "scheduled_nightly_confidence",
    workflow: { repository: repo, path: workflowPath, event: "schedule" },
    nativeReference,
    nativeRevision: pinned,
    requiredConsecutiveScheduledRuns:
      committed.requiredConsecutiveScheduledRuns,
    status: completedRuns === 0 ? "no_scheduled_runs" : "measured",
    statusDetail,
    currentConsecutiveScheduledRuns: cycles.length,
    firstQualifyingScheduledDateUtc: cycles.at(-1)?.scheduledDateUtc ?? null,
    lastQualifyingScheduledDateUtc: cycles[0]?.scheduledDateUtc ?? null,
    cycles,
    streakEnd,
    rules: committed.rules,
    publicationAuthorized: committed.publicationAuthorized,
    supersedes: committed.supersedes,
  };
  const inconsistent = ledgerProblems(ledger, pinned);
  if (inconsistent.length > 0) {
    throw new Error(
      `computed an inconsistent ledger: ${inconsistent.join("; ")}`,
    );
  }
  const text = JSON.stringify(ledger, null, 2) + "\n";

  console.log(
    `native revision ${pinned} (${nativeReference} in the index)`,
  );
  console.log(
    `workflow ${repo} ${workflowPath}: ${
      registered.includes(workflowPath) ? "registered" : "not registered"
    }, ${completedRuns} completed scheduled run(s)`,
  );
  if (statusDetail) console.log(`status ${ledger.status}: ${statusDetail}`);
  for (const cycle of cycles) {
    console.log(
      `  cycle ${cycle.scheduledDateUtc} ${cycle.runUrl} (${
        cycle.headSha.slice(0, 7)
      })`,
    );
  }
  if (streakEnd) {
    console.log(
      `  streak ends ${streakEnd.scheduledDateUtc}: ${streakEnd.detail}`,
    );
  }
  for (const run of runs) {
    if (run.event === "schedule" && run.status !== "completed") {
      console.log(
        `  pending ${run.html_url} (${run.status}, attempt ${run.run_attempt})`,
      );
    }
  }
  console.log(
    `streak: ${cycles.length} of ${committed.requiredConsecutiveScheduledRuns} consecutive qualifying scheduled runs`,
  );

  if (text === committedText) {
    console.log(`${ledgerPath}: up to date`);
  } else if (check) {
    console.error(
      `${ledgerPath}: stale; run \`mise run audit:nightly\` and commit the result`,
    );
    Deno.exit(1);
  } else {
    await Deno.writeTextFile(ledgerPath, text);
    console.log(`${ledgerPath}: rewritten`);
  }
}
