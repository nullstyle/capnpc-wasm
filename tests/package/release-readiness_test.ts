import { dayBefore, type Ledger } from "../../scripts/audit-nightly.ts";
import { type Api, apiProblems } from "../../scripts/check-sdk-api.ts";
import { fixDeclarations } from "../../scripts/fix-sdk-declarations.ts";
import { parseArguments, parseReleaseFile } from "../../scripts/release.ts";
import { stableReleaseProblems } from "../../scripts/stable-release.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const today = "2026-10-10";
Deno.test("declaration bundling retains private dependencies but exports only the entrypoint", () => {
  const original =
    "export interface Private { n: number }\nexport declare function helper(): Private;\nexport declare function factory(): number;\n";
  const result = fixDeclarations(original, ["factory"]);
  assert(
    result.includes("interface Private"),
    "private dependency was removed",
  );
  assert(
    result.includes("declare function helper"),
    "internal declaration was removed",
  );
  assert(result.endsWith("export { factory };\n"), "public export list");
  assert(
    !result.includes("export declare function helper"),
    "phantom helper export",
  );
});

Deno.test("declaration bundling refuses missing public symbols or an unknown printer format", () => {
  for (
    const original of [
      "export declare function other(): void;",
      "export { factory };",
    ]
  ) {
    let refused = false;
    try {
      fixDeclarations(original, ["factory"]);
    } catch {
      refused = true;
    }
    assert(refused, "unsupported declarations accepted");
  }
});

function qualified(): Ledger {
  const cycles: Ledger["cycles"] = [];
  let date = today;
  for (let index = 0; index < 7; index++) {
    const runId = 100 - index;
    cycles.push({
      scheduledDateUtc: date,
      runId,
      runAttempt: 1,
      runUrl: `https://github.com/nullstyle/capnpc-wasm/actions/runs/${runId}`,
      headSha: "a".repeat(40),
    });
    date = dayBefore(date);
  }
  return {
    schemaVersion: 3,
    phase: "scheduled_nightly_confidence",
    workflow: {
      repository: "nullstyle/capnpc-wasm",
      path: ".github/workflows/nightly.yml",
      event: "schedule",
    },
    requiredConsecutiveScheduledRuns: 7,
    status: "measured",
    statusDetail: null,
    currentConsecutiveScheduledRuns: 7,
    firstQualifyingScheduledDateUtc: cycles.at(-1)!.scheduledDateUtc,
    lastQualifyingScheduledDateUtc: today,
    cycles,
    streakEnd: null,
    rules: [],
    publicationAuthorized: true,
    supersedes: "capnp-zig-nightly-confidence.json",
  };
}

Deno.test("stable release accepts a current approved seven-day scheduled streak", () => {
  assert(
    stableReleaseProblems(qualified(), today).length === 0,
    "current streak",
  );
  assert(
    stableReleaseProblems(qualified(), "2026-10-11").length === 0,
    "yesterday's completed streak",
  );
});

for (
  const [name, edit] of [
    [
      "publication is not approved",
      (ledger: Ledger) => ledger.publicationAuthorized = false,
    ],
    [
      "the required count is weakened",
      (ledger: Ledger) => ledger.requiredConsecutiveScheduledRuns = 1,
    ],
    [
      "the cycle count is inflated",
      (ledger: Ledger) => ledger.currentConsecutiveScheduledRuns = 8,
    ],
    [
      "a counted run was rerun",
      (ledger: Ledger) => ledger.cycles[0].runAttempt = 2,
    ],
    [
      "a counted date is missing",
      (ledger: Ledger) => ledger.cycles[2].scheduledDateUtc = "2026-10-07",
    ],
    [
      "the workflow is manual",
      (ledger: Ledger) => ledger.workflow.event = "workflow_dispatch",
    ],
    [
      "the workflow is another repository's",
      (ledger: Ledger) => ledger.workflow.repository = "nullstyle/capnp-zig",
    ],
    [
      "the workflow path differs",
      (ledger: Ledger) => ledger.workflow.path = ".github/workflows/ci.yml",
    ],
  ] as const
) {
  Deno.test(`stable release refuses when ${name}`, () => {
    const ledger = qualified();
    edit(ledger);
    assert(stableReleaseProblems(ledger, today).length > 0, name);
  });
}

Deno.test("stable release refuses fewer than seven genuine cycles", () => {
  const ledger = qualified();
  ledger.cycles.pop();
  ledger.currentConsecutiveScheduledRuns = 6;
  ledger.firstQualifyingScheduledDateUtc =
    ledger.cycles.at(-1)!.scheduledDateUtc;
  assert(
    stableReleaseProblems(ledger, today).length > 0,
    "six cycles admitted",
  );
});

Deno.test("stable release refuses stale or future evidence", () => {
  assert(stableReleaseProblems(qualified(), "2026-10-12").length > 0, "stale");
  assert(stableReleaseProblems(qualified(), "2026-10-09").length > 0, "future");
});

Deno.test("stable release refuses the current unapproved failing ledger", async () => {
  const ledger = JSON.parse(
    await Deno.readTextFile(
      "docs/release-evidence/nightly-confidence.json",
    ),
  ) as Ledger;
  // Keep this test valid after the real gate eventually passes.
  ledger.publicationAuthorized = false;
  assert(
    stableReleaseProblems(ledger, today).length > 0,
    "unapproved evidence",
  );
});

Deno.test("stable metadata supports independent flavor versions", async () => {
  const original = JSON.parse(await Deno.readTextFile("release.json"));
  const stable = {
    ...original,
    private: false,
    versions: {
      "capnpc-wasm": "0.1.0",
      "capnp-wasm-tools": "0.1.0-rc.4",
      "capnp-wasm-compiler-host": "0.2.0-rc.1",
    },
  };
  const parsed = parseReleaseFile(JSON.stringify(stable));
  assert(parsed.versions["capnpc-wasm"] === "0.1.0", "stable version");
  assert(parsed.versions["capnp-wasm-tools"] === "0.1.0-rc.4", "RC version");
  assert(parseArguments(["--stable", "--publish"]).stable === true, "opt-in");
  for (
    const version of [
      "01.1.0",
      "0.01.0",
      "0.1.00",
      "0.1.0+build",
      "0.1.0-beta.1",
    ]
  ) {
    let refused = false;
    try {
      parseReleaseFile(JSON.stringify({
        ...stable,
        versions: { ...stable.versions, "capnpc-wasm": version },
      }));
    } catch {
      refused = true;
    }
    assert(refused, `invalid version admitted: ${version}`);
  }
});

Deno.test("API guard detects a changed TS request and a removed Go field", async () => {
  const expected: Api = {
    "typescript-api.d.ts": await Deno.readTextFile(
      "tests/fixtures/contract/typescript-api.d.ts",
    ),
    "go-api.txt": await Deno.readTextFile("tests/fixtures/contract/go-api.txt"),
  };
  assert(apiProblems(expected, expected).length === 0, "unchanged API");
  const actual: Api = {
    "typescript-api.d.ts": expected["typescript-api.d.ts"].replace(
      /\bfiles:(\s+)Files;/,
      "files?:$1Files;",
    ),
    "go-api.txt": expected["go-api.txt"].replace(
      "\tImportPaths []string\n",
      "",
    ),
  };
  assert(
    actual["typescript-api.d.ts"] !== expected["typescript-api.d.ts"],
    "TS probe did not change a public field",
  );
  assert(
    actual["go-api.txt"] !== expected["go-api.txt"],
    "Go probe did not remove a public field",
  );
  assert(apiProblems(actual, expected).length === 2, "API drift was admitted");
});
