// The nightly streak (computeStreak) and the ledger invariants
// (ledgerProblems) of scripts/audit-nightly.ts, on synthetic runs; no network.
// `mise run test:evidence` runs it with tests/check_evidence_test.ts.
import {
  computeStreak,
  dayBefore,
  type Ledger,
  ledgerProblems,
  type Run,
  type Streak,
} from "../scripts/audit-nightly.ts";

const pinned = "a".repeat(40);
const other = "b".repeat(40);
const today = "2026-10-10";
let nextId = 1000;
function run(
  date: string,
  over: Partial<Run> & { rev?: string } = {},
): Run & { rev: string } {
  const id = over.id ?? nextId++;
  return {
    id,
    run_attempt: 1,
    event: "schedule",
    status: "completed",
    conclusion: "success",
    head_sha: `${String(id).padStart(40, "0")}`,
    created_at: `${date}T11:30:00Z`,
    html_url: `https://github.com/o/r/actions/runs/${id}`,
    rev: pinned,
    ...over,
  };
}
async function streak(runs: (Run & { rev: string })[]) {
  const byHead = new Map(runs.map((r) => [r.head_sha, r.rev]));
  const calls: string[] = [];
  const result = await computeStreak(runs, pinned, today, (r) => {
    calls.push(r.head_sha);
    return Promise.resolve(byHead.get(r.head_sha)!);
  });
  return { ...result, calls };
}
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: got ${a}, want ${e}`);
}
function days(n: number, from = today): string[] {
  const out = [from];
  while (out.length < n) out.push(dayBefore(out.at(-1)!));
  return out;
}

Deno.test("dayBefore crosses months and years", () => {
  eq(dayBefore("2026-03-01"), "2026-02-28", "march");
  eq(dayBefore("2028-03-01"), "2028-02-29", "leap");
  eq(dayBefore("2027-01-01"), "2026-12-31", "year");
});

Deno.test("no runs", async () => {
  const s = await streak([]);
  eq(s.cycles, [], "cycles");
  eq(s.streakEnd, null, "end");
});

Deno.test("only an in-progress run", async () => {
  const s = await streak([
    run(today, { status: "in_progress", conclusion: null }),
  ]);
  eq(s.cycles.length, 0, "count");
  eq(s.streakEnd, null, "end");
});

Deno.test("seven consecutive ending yesterday, nothing older", async () => {
  const s = await streak(days(7, dayBefore(today)).map((d) => run(d)));
  eq(s.cycles.length, 7, "count");
  eq(s.cycles[0].scheduledDateUtc, "2026-10-09", "newest");
  eq(s.cycles[6].scheduledDateUtc, "2026-10-03", "oldest");
  eq(s.streakEnd, null, "end");
});

Deno.test("today and yesterday succeed, the day before failed", async () => {
  const [d0, d1, d2] = days(3);
  const s = await streak([
    run(d0),
    run(d1),
    run(d2, { conclusion: "failure" }),
  ]);
  eq(s.cycles.map((c) => c.scheduledDateUtc), [d0, d1], "dates");
  eq(s.streakEnd?.kind, "conclusion", "kind");
  eq(s.streakEnd?.scheduledDateUtc, d2, "end date");
});

Deno.test("a missing day ends the streak", async () => {
  const [, d1, d2, d3] = days(4);
  const s = await streak([run(d1), run(d3)]);
  eq(s.cycles.map((c) => c.scheduledDateUtc), [d1], "dates");
  eq(s.streakEnd, {
    scheduledDateUtc: d2,
    kind: "missed",
    detail: `no completed scheduled run on ${d2}`,
    runUrl: null,
  }, "end");
});

Deno.test("newest completed run older than yesterday", async () => {
  const [, d1, , d3] = days(4);
  const s = await streak([run(d3)]);
  eq(s.cycles.length, 0, "count");
  eq(s.streakEnd?.kind, "missed", "kind");
  eq(s.streakEnd?.scheduledDateUtc, d1, "missed yesterday");
});

Deno.test("another native revision ends the streak", async () => {
  const [d0, d1, d2] = days(3);
  const s = await streak([run(d0), run(d1, { rev: other }), run(d2)]);
  eq(s.cycles.length, 1, "count");
  eq(s.streakEnd?.kind, "native_revision", "kind");
  eq(s.streakEnd?.scheduledDateUtc, d1, "date");
});

Deno.test("a failed run is never looked up", async () => {
  const [d0] = days(1);
  const s = await streak([run(d0, { conclusion: "cancelled" })]);
  eq(s.calls.length, 0, "no revision lookups");
  eq(s.streakEnd?.detail.includes("cancelled"), true, "detail");
});

Deno.test("any re-run ends the streak", async () => {
  // The API reports only a run's latest attempt, so a re-run after a failed
  // first attempt and a re-run of a passed one look the same: success, attempt 2.
  const [d0, d1, d2] = days(3);
  const rerun = run(d1, { run_attempt: 2 });
  const s = await streak([run(d0), rerun, run(d2)]);
  eq(s.cycles.map((c) => c.scheduledDateUtc), [d0], "dates");
  eq(s.streakEnd, {
    scheduledDateUtc: d1,
    kind: "rerun",
    detail: `run ${rerun.id} was re-run (attempt 2)`,
    runUrl: rerun.html_url,
  }, "end");
});

Deno.test("a re-run in progress on an older date ends the streak and is named", async () => {
  const [d0, d1, d2] = days(3);
  const pending = run(d1, {
    status: "in_progress",
    conclusion: null,
    run_attempt: 2,
  });
  const s = await streak([run(d0), pending, run(d2)]);
  eq(s.cycles.map((c) => c.scheduledDateUtc), [d0], "dates");
  eq(s.streakEnd, {
    scheduledDateUtc: d1,
    kind: "missed",
    detail:
      `no completed scheduled run on ${d1}; run ${pending.id} (attempt 2) is in_progress`,
    runUrl: pending.html_url,
  }, "end");
});

Deno.test("a pending run yesterday, with none today, ends the streak before it starts", async () => {
  const [, d1, d2] = days(3);
  const pending = run(d1, { status: "queued", conclusion: null });
  const s = await streak([pending, run(d2)]);
  eq(s.cycles.length, 0, "count");
  eq(s.streakEnd?.scheduledDateUtc, d1, "date");
  eq(s.streakEnd?.runUrl, pending.html_url, "names the pending run");
});

Deno.test("same-day duplicate: newer success, older failure", async () => {
  const [d0] = days(1);
  const s = await streak([
    run(d0, { created_at: `${d0}T12:00:00Z` }),
    run(d0, { created_at: `${d0}T11:00:00Z`, conclusion: "failure" }),
  ]);
  eq(s.cycles.length, 1, "count");
  eq(s.streakEnd?.kind, "conclusion", "kind");
});

Deno.test("same-day duplicate successes count once", async () => {
  const [d0, d1] = days(2);
  const s = await streak([
    run(d0, { created_at: `${d0}T12:00:00Z` }),
    run(d0, { created_at: `${d0}T11:00:00Z` }),
    run(d1),
  ]);
  eq(s.cycles.map((c) => c.scheduledDateUtc), [d0, d1], "dates");
  eq(s.streakEnd, null, "end");
});

Deno.test("non-schedule events and the newest pending run are ignored; input order does not matter", async () => {
  const [d0, d1, d2] = days(3);
  const s = await streak([
    run(d2),
    run(d0, { status: "in_progress", conclusion: null }),
    run(d1, { event: "workflow_dispatch", conclusion: "failure" }),
    run(d1),
  ]);
  eq(s.cycles.map((c) => c.scheduledDateUtc), [d1, d2], "dates");
  eq(s.streakEnd, null, "end");
});

Deno.test("cycles record run id, attempt, url, head", async () => {
  const [, d1] = days(2);
  const r = run(d1);
  const s = await streak([r]);
  eq(s.cycles[0], {
    scheduledDateUtc: d1,
    runId: r.id,
    runAttempt: 1,
    runUrl: r.html_url,
    headSha: r.head_sha,
  }, "cycle");
});

// A ledger as audit-nightly.ts writes it for a computed streak.
function ledgerOf(s: Streak, over: Partial<Ledger> = {}): Ledger {
  const runs = s.cycles.length > 0 || s.streakEnd !== null;
  return {
    schemaVersion: 2,
    phase: "scheduled_nightly_confidence",
    workflow: {
      repository: "o/r",
      path: ".github/workflows/nightly.yml",
      event: "schedule",
    },
    nativeReference: "ref/capnp-zig",
    nativeRevision: pinned,
    requiredConsecutiveScheduledRuns: 7,
    status: runs ? "measured" : "no_scheduled_runs",
    statusDetail: runs ? null : "no completed scheduled run yet",
    currentConsecutiveScheduledRuns: s.cycles.length,
    firstQualifyingScheduledDateUtc: s.cycles.at(-1)?.scheduledDateUtc ?? null,
    lastQualifyingScheduledDateUtc: s.cycles[0]?.scheduledDateUtc ?? null,
    cycles: s.cycles,
    streakEnd: s.streakEnd,
    rules: ["rule"],
    publicationAuthorized: false,
    supersedes: "capnp-zig-nightly-confidence.json",
    ...over,
  };
}
function includes(problems: string[], ...needles: string[]) {
  for (const needle of needles) {
    if (!problems.some((problem) => problem.includes(needle))) {
      throw new Error(
        `no problem mentions ${JSON.stringify(needle)}: ${
          JSON.stringify(problems)
        }`,
      );
    }
  }
}

Deno.test("ledgers computed from any streak are consistent", async () => {
  const [d0, d1, d2, d3] = days(4);
  for (
    const runs of [
      [],
      days(7, d1).map((d) => run(d)),
      [run(d0), run(d1), run(d2, { conclusion: "failure" })],
      [run(d1), run(d3)],
      [run(d0), run(d1, { run_attempt: 2 })],
      [run(d0), run(d1, { status: "in_progress", conclusion: null }), run(d2)],
      [run(d0), run(d1, { rev: other })],
    ]
  ) {
    eq(ledgerProblems(ledgerOf(await streak(runs)), pinned), [], "problems");
  }
});

Deno.test("ledger: a counter of 7 with no cycles", () => {
  includes(
    ledgerProblems(
      ledgerOf({ cycles: [], streakEnd: null }, {
        currentConsecutiveScheduledRuns: 7,
        status: "measured",
      }),
      pinned,
    ),
    "currentConsecutiveScheduledRuns is 7 but the ledger lists 0 cycles",
    "status measured takes no statusDetail",
  );
});

Deno.test("ledger: forged cycles from another repository, a re-run, out of order", async () => {
  const s = await streak(days(2, dayBefore(today)).map((d) => run(d)));
  const [newer, older] = s.cycles;
  const forged = [
    {
      ...older,
      runAttempt: 3,
      runUrl: `https://github.com/someone/else/actions/runs/${older.runId}`,
    },
    newer,
  ];
  includes(
    ledgerProblems(
      ledgerOf({ cycles: forged, streakEnd: null }, {
        firstQualifyingScheduledDateUtc: "2026-01-01",
      }),
      pinned,
    ),
    "cycles[0].runUrl https://github.com/someone/else/",
    "cycles[0] passed on attempt 3",
    `cycles[1] is dated ${newer.scheduledDateUtc}, not ${
      dayBefore(older.scheduledDateUtc)
    }`,
    "firstQualifyingScheduledDateUtc is 2026-01-01",
  );
});

Deno.test("ledger: a nativeRevision the index no longer pins", () => {
  includes(
    ledgerProblems(
      ledgerOf({ cycles: [], streakEnd: null }, { nativeRevision: other }),
      pinned,
    ),
    `nativeRevision ${other} is not the ref/capnp-zig gitlink in the index`,
  );
});

Deno.test("ledger: status, detail, streak end, and supersedes must agree", async () => {
  const s = await streak([run(dayBefore(today))]);
  includes(
    ledgerProblems(ledgerOf(s, { status: "no_scheduled_runs" }), pinned),
    "status no_scheduled_runs, but the ledger records runs",
    "status no_scheduled_runs needs a statusDetail",
  );
  includes(
    ledgerProblems(
      ledgerOf({ cycles: [], streakEnd: null }, {
        status: "measured",
        statusDetail: null,
        supersedes: "nightly-confidence.json",
      }),
      pinned,
    ),
    "status measured, but the ledger records no run",
    "supersedes names the ledger itself",
  );
  includes(
    ledgerProblems(
      ledgerOf(s, {
        streakEnd: {
          scheduledDateUtc: "2026-01-01",
          kind: "missed",
          detail: "forged",
          runUrl: "https://github.com/someone/else/actions/runs/1",
        },
      }),
      pinned,
    ),
    "streakEnd.runUrl https://github.com/someone/else/actions/runs/1 is not a run of o/r",
    "streakEnd is dated 2026-01-01",
  );
});

Deno.test("a re-run in progress older than every completed run is named", async () => {
  const [d0, d1] = days(2);
  const pending = run(d1, {
    status: "in_progress",
    conclusion: null,
    run_attempt: 2,
  });
  const s = await streak([run(d0), pending]);
  eq(s.cycles.map((c) => c.scheduledDateUtc), [d0], "dates");
  eq(s.streakEnd?.runUrl, pending.html_url, "names the pending run");
  eq(ledgerProblems(ledgerOf(s), pinned), [], "consistent");
});

Deno.test("a pending run two days before the oldest cycle ends the streak the day before it", async () => {
  const [d0, , d2] = days(3);
  const s = await streak([
    run(d0),
    run(d2, { status: "queued", conclusion: null }),
  ]);
  eq(s.streakEnd?.scheduledDateUtc, dayBefore(d0), "missed date");
  eq(s.streakEnd?.runUrl, null, "no run that day");
  eq(ledgerProblems(ledgerOf(s), pinned), [], "consistent");
});
