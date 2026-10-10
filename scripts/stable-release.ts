// Stable archives need the recorded publication decision, a fresh seven-day
// scheduled streak, and the reviewed SDK API. RC packaging does not use this
// guard. Publish mode also compares the ledger with GitHub, read-only, so a
// scheduled run re-run or failed since the ledger was committed blocks it.
import { dayBefore, type Ledger, ledgerProblems } from "./audit-nightly.ts";
import { checkSdkApi } from "./check-sdk-api.ts";

export function stableReleaseProblems(ledger: Ledger, today: string): string[] {
  const problems = ledgerProblems(ledger);
  if (
    ledger.schemaVersion !== 3 ||
    ledger.phase !== "scheduled_nightly_confidence" ||
    ledger.workflow.repository !== "nullstyle/capnpc-wasm" ||
    ledger.workflow.path !== ".github/workflows/nightly.yml" ||
    ledger.workflow.event !== "schedule"
  ) {
    problems.push(
      "the ledger must describe this repository's scheduled nightly",
    );
  }
  if (
    ledger.status !== "measured" ||
    ledger.requiredConsecutiveScheduledRuns !== 7 ||
    ledger.currentConsecutiveScheduledRuns < 7
  ) {
    problems.push(
      "seven consecutive successful scheduled nightlies are required",
    );
  }
  const newest = ledger.lastQualifyingScheduledDateUtc;
  if (newest !== today && newest !== dayBefore(today)) {
    problems.push("the scheduled streak must end today or yesterday (UTC)");
  }
  if (ledger.publicationAuthorized !== true) {
    problems.push(
      "publicationAuthorized must be true after maintainer approval",
    );
  }
  return problems;
}

export async function checkStableRelease(publish: boolean): Promise<void> {
  const path = "docs/release-evidence/nightly-confidence.json";
  const ledger = JSON.parse(await Deno.readTextFile(path)) as Ledger;
  const problems = stableReleaseProblems(
    ledger,
    new Date().toISOString().slice(0, 10),
  );
  if (problems.length) {
    throw new Error(`stable release blocked:\n${problems.join("\n")}`);
  }
  await checkSdkApi();
  if (publish) {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-run=gh",
        "scripts/audit-nightly.ts",
        "--check",
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success) {
      throw new Error(
        `stable release blocked: the live nightly audit failed\n${
          new TextDecoder().decode(result.stdout)
        }${new TextDecoder().decode(result.stderr)}`,
      );
    }
  }
}
