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
import {
  classifyError,
  type ErrorSummary,
  expectedPath,
  loadExpected,
  validateExpected,
} from "./outcome.ts";
import { classify as classifyLauncherStep } from "./launcher-surface.ts";
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

suite.test("the TypeScript classifier reads the innermost cause, not guest stderr", () => {
  const failure = (
    message: string,
    chain: { name: string; message: string }[],
    exitCode?: number,
  ): ErrorSummary => ({
    name: "CompileError",
    message,
    isCompileError: true,
    isTypeError: false,
    stage: "cpp",
    exitCode,
    diagnostics: [],
    hasOutputs: false,
    chain,
  });
  // The wrapper carries the guest's stderr; only the innermost cause counts.
  const wrapped = (stderr: string, name: string, message: string) =>
    failure(`cpp trapped: WASI command failed: ${message}\n${stderr}`, [
      { name: "CommandError", message: `WASI command failed: ${message}` },
      { name, message },
    ]);
  const cases: [ErrorSummary, string][] = [
    [wrapped("error: stack overflow", "RuntimeError", "unreachable"), "trap"],
    [
      wrapped(
        "outputBytes resource limit exceeded",
        "RuntimeError",
        "unreachable",
      ),
      "trap",
    ],
    [
      wrapped("", "RangeError", "Maximum call stack size exceeded"),
      "trap:stack",
    ],
    [wrapped("", "InternalError", "too much recursion"), "trap:stack"],
    [
      wrapped("", "RangeError", "WebAssembly.instantiate(): Out of memory"),
      "error:RangeError",
    ],
    [
      wrapped("", "LimitError", "stderrBytes resource limit exceeded"),
      "limit:stderrBytes",
    ],
    [
      wrapped("", "TypeError", "path exceeds pathBytes limit"),
      "limit:pathBytes",
    ],
    [
      wrapped("", "Error", 'invalid filesystem entry name: "a\\\\b"'),
      "policy:output-name",
    ],
    [failure("compiler emitted no request", []), "protocol"],
    [failure("cpp generator unexpectedly wrote to stdout", []), "protocol"],
    [failure("cpp exited with status 1", [], 1), "exit(1)"],
  ];
  for (const [summary, expected] of cases) {
    const outcome = classifyError(summary);
    assert(
      outcome === expected,
      `${
        JSON.stringify(summary.chain.at(-1) ?? summary.message)
      }: ${outcome}, expected ${expected}`,
    );
  }
});

suite.test("the launcher classifier reads Wasmtime's report, not guest stderr", () => {
  const report = (trap: string) =>
    `Error: failed to run main module \`./m.wasm\`\n\nCaused by:\n    0: failed to invoke command default\n    1: error while executing at wasm backtrace:\n    2: wasm trap: ${trap}\n`;
  const cases: [Parameters<typeof classifyLauncherStep>[0], string][] = [
    [
      { code: 134, signal: null, report: report("call stack exhausted") },
      "trap:stack",
    ],
    [{ code: 134, signal: null, report: report("interrupt") }, "timeout"],
    [
      {
        code: 134,
        signal: null,
        report: report("wasm `unreachable` instruction executed"),
      },
      "trap",
    ],
    // A Wasmtime killed by SIGABRT also exits 134, without a trap report.
    [{ code: 134, signal: null, report: "" }, "exit(134)"],
    [{ code: 1, signal: null, report: "" }, "exit(1)"],
    [{ code: 0, signal: null, report: "" }, "ok"],
  ];
  for (const [step, expected] of cases) {
    const outcome = classifyLauncherStep(step);
    assert(
      outcome === expected,
      `${JSON.stringify(step)}: ${outcome}, expected ${expected}`,
    );
  }
});

suite.test("TypeScript direct execution conforms to the corpus", async (t) => {
  const rows = await runTsSurface(t, "ts-direct");
  // A fixed path outside the suite's work directories, which a green run
  // deletes: the matrix stays for inspection and the next run replaces it.
  const matrix = `${buildTest}/conformance-ts-direct.json`;
  await Deno.mkdir(buildTest, { recursive: true });
  await Deno.writeTextFile(matrix, JSON.stringify(rows, null, 2) + "\n");
  const skipped = rows.filter((row) => row.skipped).length;
  console.log(
    `ts-direct: ${
      rows.length - skipped
    } cases observed, ${skipped} skipped; matrix in build/test/conformance-ts-direct.json`,
  );
  for (const row of rows) {
    if (row.observation) {
      console.log(`  ${row.name}: ${describeObservation(row.observation)}`);
    }
  }
});
