// scripts/check-evidence.ts on copies of docs/release-evidence with planted
// defects: each copy lives under build/test and is removed afterwards. The
// ledger checks read the ref/capnp-zig gitlink with `git ls-files`.
// `mise run test:evidence` runs it with tests/audit_nightly_test.ts.
import {
  checkEvidence,
  type EvidenceReport,
} from "../scripts/check-evidence.ts";

const source = "docs/release-evidence";
const ledgerName = "nightly-confidence.json";
// The gitlink the ledger named before the 295ff5e bump.
const previousPin = "0fb8df40126ea166f95016963c465b03db22819e";

type Ledger = Record<string, unknown> & { cycles: Record<string, unknown>[] };

async function copyEvidence(): Promise<string> {
  await Deno.mkdir("build/test", { recursive: true });
  const copy = await Deno.makeTempDir({
    dir: "build/test",
    prefix: "evidence-",
  });
  await Deno.mkdir(`${copy}/schemas`);
  for (const directory of ["", "/schemas"]) {
    for await (const entry of Deno.readDir(`${source}${directory}`)) {
      if (entry.isFile) {
        await Deno.copyFile(
          `${source}${directory}/${entry.name}`,
          `${copy}${directory}/${entry.name}`,
        );
      }
    }
  }
  return copy;
}

/** Check a copy of the evidence after `plant` has changed it. */
async function planted(
  plant: (copy: string) => Promise<void>,
): Promise<EvidenceReport> {
  const copy = await copyEvidence();
  try {
    await plant(copy);
    return await checkEvidence(copy);
  } finally {
    await Deno.remove(copy, { recursive: true });
  }
}

function editLedger(edit: (ledger: Ledger) => void) {
  return async (copy: string) => {
    const path = `${copy}/${ledgerName}`;
    const ledger = JSON.parse(await Deno.readTextFile(path)) as Ledger;
    edit(ledger);
    await Deno.writeTextFile(path, JSON.stringify(ledger, null, 2) + "\n");
  };
}

function expectFailures(report: EvidenceReport, ...needles: string[]) {
  for (const needle of needles) {
    if (!report.failures.some((failure) => failure.includes(needle))) {
      throw new Error(
        `no failure mentions ${JSON.stringify(needle)}:\n${
          report.failures.join("\n")
        }`,
      );
    }
  }
}

// Two cycles for a copy of the ledger: the given attempt and repository, in
// the given order.
function cycles(
  repository: string,
  runAttempt: number,
  order: "newest first" | "oldest first",
) {
  const list = [
    ["2026-09-24", 102],
    ["2026-09-23", 101],
  ].map(([scheduledDateUtc, runId]) => ({
    scheduledDateUtc,
    runId,
    runAttempt,
    runUrl: `https://github.com/${repository}/actions/runs/${runId}`,
    headSha: "1".repeat(40),
  }));
  return order === "newest first" ? list : list.reverse();
}

Deno.test("the committed evidence passes", async () => {
  const report = await checkEvidence(source);
  if (report.failures.length > 0) throw new Error(report.failures.join("\n"));
  if (report.receipts < 12) throw new Error(`only ${report.receipts} receipts`);
});

Deno.test("an unchanged copy passes", async () => {
  const report = await planted(() => Promise.resolve());
  if (report.failures.length > 0) throw new Error(report.failures.join("\n"));
});

Deno.test("planted: the ledger names the previous pin 0fb8df4", async () => {
  expectFailures(
    await planted(editLedger((ledger) => {
      ledger.nativeRevision = previousPin;
    })),
    `${ledgerName}: nativeRevision ${previousPin} is not the ref/capnp-zig gitlink in the index`,
  );
});

Deno.test("planted: the ledger counts 7 runs with no cycles", async () => {
  expectFailures(
    await planted(editLedger((ledger) => {
      ledger.currentConsecutiveScheduledRuns = 7;
      ledger.status = "measured";
    })),
    `${ledgerName}: currentConsecutiveScheduledRuns is 7 but the ledger lists 0 cycles`,
    `${ledgerName}: status measured takes no statusDetail`,
  );
});

Deno.test("planted: forged cycles from another repository, attempt 3, out of order", async () => {
  expectFailures(
    await planted(editLedger((ledger) => {
      ledger.status = "measured";
      ledger.statusDetail = null;
      ledger.cycles = cycles("someone/else", 3, "oldest first");
      ledger.currentConsecutiveScheduledRuns = 7;
      ledger.firstQualifyingScheduledDateUtc = "2026-01-01";
      ledger.lastQualifyingScheduledDateUtc = null;
    })),
    `${ledgerName}.cycles[0].runAttempt: expected 1`,
    `${ledgerName}.cycles[1].runAttempt: expected 1`,
  );
});

Deno.test("planted: forged first-attempt cycles from another repository, out of order", async () => {
  expectFailures(
    await planted(editLedger((ledger) => {
      ledger.status = "measured";
      ledger.statusDetail = null;
      ledger.cycles = cycles("someone/else", 1, "oldest first");
      ledger.currentConsecutiveScheduledRuns = 7;
      ledger.firstQualifyingScheduledDateUtc = "2026-01-01";
      ledger.lastQualifyingScheduledDateUtc = null;
    })),
    "cycles[0].runUrl https://github.com/someone/else/actions/runs/101 is not run 101 of nullstyle/capnpc-wasm",
    "cycles[1] is dated 2026-09-24, not 2026-09-22",
    "currentConsecutiveScheduledRuns is 7 but the ledger lists 2 cycles",
    "firstQualifyingScheduledDateUtc is 2026-01-01 but the oldest cycle is 2026-09-24",
    "lastQualifyingScheduledDateUtc is null but the newest cycle is 2026-09-23",
  );
});

Deno.test("planted: another repository with matching run URLs", async () => {
  expectFailures(
    await planted(editLedger((ledger) => {
      ledger.workflow = {
        repository: "someone/else",
        path: ".github/workflows/nightly.yml",
        event: "schedule",
      };
      ledger.status = "measured";
      ledger.statusDetail = null;
      ledger.cycles = cycles("someone/else", 1, "newest first");
      ledger.currentConsecutiveScheduledRuns = 2;
      ledger.firstQualifyingScheduledDateUtc = "2026-09-23";
      ledger.lastQualifyingScheduledDateUtc = "2026-09-24";
    })),
    `${ledgerName}.workflow.repository: expected "nullstyle/capnpc-wasm"`,
  );
});

Deno.test("planted: the ledger supersedes itself", async () => {
  expectFailures(
    await planted(editLedger((ledger) => {
      ledger.supersedes = ledgerName;
    })),
    `${ledgerName}: supersedes names the ledger itself`,
  );
});

Deno.test("planted: a receipt in a subdirectory", async () => {
  expectFailures(
    await planted(async (copy) => {
      await Deno.mkdir(`${copy}/extra`);
      await Deno.writeTextFile(`${copy}/extra/anything.json`, "{}\n");
    }),
    "extra: not a receipt",
  );
});

Deno.test("planted: a file the schemas directory does not expect", async () => {
  expectFailures(
    await planted((copy) =>
      Deno.writeTextFile(`${copy}/schemas/notes.txt`, "notes\n")
    ),
    "schemas/notes.txt: not a receipt",
  );
});

// A receipt shaped like the one test:package writes today: schemaVersion 1
// first, per-flavor versions (toolsVersion), and the compiler-path digests.
async function currentPackageReceipt(copy: string, over = {}) {
  const base = JSON.parse(
    await Deno.readTextFile(`${copy}/94ba6b2-private-package.json`),
  );
  const digest = (fill: string) => fill.repeat(64);
  const receipt = {
    schemaVersion: 1,
    version: "0.1.0-rc.4",
    source: base.source,
    archiveSha256: digest("a"),
    manifestSha256: digest("b"),
    sbomSha256: digest("c"),
    toolsVersion: "0.1.0-rc.3",
    toolsArchiveSha256: digest("d"),
    checks: base.checks,
    generated: base.generated,
    paths: {
      "paths/request": digest("e"),
      "paths/request-reversed": digest("f"),
    },
    ...over,
  };
  await Deno.writeTextFile(
    `${copy}/c0ffee1-private-package.json`,
    JSON.stringify(receipt, null, 2) + "\n",
  );
}

Deno.test("a package receipt as test:package writes it now passes", async () => {
  const report = await planted((copy) => currentPackageReceipt(copy));
  if (report.failures.length > 0) throw new Error(report.failures.join("\n"));
  const line =
    "PASS c0ffee1-private-package.json (private-package.schema.json, schemaVersion 1)";
  if (!report.lines.includes(line)) {
    throw new Error(`missing ${line}:\n${report.lines.join("\n")}`);
  }
});

Deno.test("planted: a package receipt with a malformed toolsVersion and path digest", async () => {
  expectFailures(
    await planted((copy) =>
      currentPackageReceipt(copy, {
        toolsVersion: "rc3",
        paths: { "paths/request": "not-a-digest" },
      })
    ),
    'c0ffee1-private-package.json.toolsVersion: "rc3" does not match',
    'c0ffee1-private-package.json.paths["paths/request"]: "not-a-digest" does not match',
  );
});
