// The conformance corpus's own gate (`mise run test:conformance`): the
// materialized JSON matches cases.ts, guests.json matches its assembled
// sources, expected.json covers every case with vocabulary outcomes and
// reasoned divergences, and the reference surface (the TypeScript SDK in
// direct execution on the pinned Deno) conforms. The other surfaces run the
// same corpus in their own suites: sdk/typescript/conformance_test.ts (worker
// execution on the supported Deno), sdk/go/conformance_test.go,
// tests/package/launcher.ts, and tests/browser/test.ts.
import { assert } from "../lib/assert.ts";
import { buildTest } from "../lib/paths.ts";
import { testSuite } from "../lib/workdir.ts";
import {
  cases,
  casesPath,
  loadCases,
  materialize,
  standardReader,
} from "./cases.ts";
import { driftedGuests, guestsPath } from "./guests.ts";
import { expectedPath, loadExpected, validateExpected } from "./outcome.ts";
import { describeObservation } from "./outcome.ts";
import { runTsSurface } from "./ts-surface.ts";

const suite = testSuite("conformance-");
const root = new URL("../../", import.meta.url);

suite.test(`${casesPath} matches tests/conformance/cases.ts`, async () => {
  const recorded = await loadCases(root);
  const current = await materialize(standardReader(root));
  assert(
    JSON.stringify(recorded) === JSON.stringify(current),
    `${casesPath} is stale: regenerate it with tests/conformance/cases.ts --write`,
  );
  assert(recorded.length === cases.length, "case count differs");
});

suite.test(`${guestsPath} matches the assembled guest sources`, async () => {
  const drifted = await driftedGuests(root);
  assert(
    drifted.length === 0,
    `${guestsPath} is stale for ${
      drifted.join(", ")
    }: regenerate it with tests/conformance/guests.ts --write`,
  );
});

suite.test(`${expectedPath} covers every case with reasoned divergences`, async () => {
  const expected = await loadExpected(root);
  const problems = validateExpected(
    expected,
    (await loadCases(root)).map((spec) => spec.name),
  );
  assert(problems.length === 0, problems.join("\n"));
});

suite.test("TypeScript direct execution conforms to the corpus", async (t) => {
  const rows = await runTsSurface(t, "ts-direct");
  const directory = await suite.workDir("matrix-");
  await Deno.writeTextFile(
    `${directory}/ts-direct.json`,
    JSON.stringify(rows, null, 2) + "\n",
  );
  const skipped = rows.filter((row) => row.skipped).length;
  console.log(
    `ts-direct: ${
      rows.length - skipped
    } cases observed, ${skipped} skipped; matrix in ${
      directory.replace(`${buildTest}/`, "build/test/")
    }`,
  );
  for (const row of rows) {
    if (row.observation) {
      console.log(`  ${row.name}: ${describeObservation(row.observation)}`);
    }
  }
});
