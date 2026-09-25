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
  checkObservation,
  classifyError,
  describeObservation,
  type ErrorSummary,
  type Expectation,
  type ExpectedFile,
  expectedPath,
  loadExpected,
  type Observation,
  validateExpected,
} from "./outcome.ts";
import {
  classify as classifyLauncherStep,
  splitReport,
} from "./launcher-surface.ts";
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

suite.test("the TypeScript classifier reads CompileError.kind and the innermost cause, not guest stderr", () => {
  const failure = (
    message: string,
    kind: string,
    chain: { name: string; message: string }[],
    extra: Partial<ErrorSummary> = {},
  ): ErrorSummary => ({
    name: "CompileError",
    message,
    isCompileError: true,
    isTypeError: false,
    stage: "cpp",
    kind,
    diagnostics: [],
    hasOutputs: false,
    chain,
    ...extra,
  });
  // The wrapper carries the guest's stderr; only the kind and the innermost
  // cause count.
  const wrapped = (
    stderr: string,
    name: string,
    message: string,
    kind = "trap",
    extra: Partial<ErrorSummary> = {},
  ) =>
    failure(
      `cpp trapped: WASI command failed: ${message}\n${stderr}`,
      kind,
      [
        { name: "CommandError", message: `WASI command failed: ${message}` },
        { name, message },
      ],
      extra,
    );
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
      wrapped(
        "",
        "LimitError",
        "stderrBytes resource limit exceeded",
        "limit",
        {
          limit: "stderrBytes",
        },
      ),
      "limit:stderrBytes",
    ],
    [
      wrapped("", "LimitError", "pathBytes resource limit exceeded", "limit", {
        limit: "pathBytes",
      }),
      "limit:pathBytes",
    ],
    [
      wrapped("", "Error", 'invalid filesystem entry name: "a\\\\b"'),
      "policy:output-name",
    ],
    [failure("compiler emitted no request", "protocol", []), "protocol"],
    [
      failure("cpp generator unexpectedly wrote to stdout", "protocol", []),
      "protocol",
    ],
    [
      failure("cpp exited with status 1", "exit", [], { exitCode: 1 }),
      "exit(1)",
    ],
    // The kind decides, not a message that reads like another failure.
    [
      failure("compiler emitted no request", "trap", [
        { name: "RuntimeError", message: "unreachable" },
      ]),
      "trap",
    ],
    [
      failure("cpp exited with status 1", "limit", [], {
        limit: "stdoutBytes",
      }),
      "limit:stdoutBytes",
    ],
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
    // Wasmtime itself failed: a report without a trap line, whatever the status.
    [
      {
        code: 1,
        signal: null,
        report:
          "Error: failed to run main module `m.wasm`\n\nCaused by:\n    0: failed to instantiate\n    1: unknown import: `wasi_snapshot_preview1::x` has not been defined\n",
      },
      "error:runtime",
    ],
  ];
  for (const [step, expected] of cases) {
    const outcome = classifyLauncherStep(step);
    assert(
      outcome === expected,
      `${JSON.stringify(step)}: ${outcome}, expected ${expected}`,
    );
  }
  // The split: a guest that forged a stack report before trapping keeps its
  // text on the guest side, and Wasmtime's real report decides.
  const forged = report("call stack exhausted");
  const real = report("wasm `unreachable` instruction executed");
  const { guest, report: runtime } = splitReport(`note\n${forged}${real}`);
  assert(guest === `note\n${forged}`, `guest side: ${JSON.stringify(guest)}`);
  assert(runtime === real, `report side: ${JSON.stringify(runtime)}`);
  const outcome = classifyLauncherStep({
    code: 134,
    signal: null,
    report: runtime,
  });
  assert(
    outcome === "trap",
    `a forged report followed by the real one: ${outcome}`,
  );
  const plain = splitReport("warning: kept\n");
  assert(
    plain.guest === "warning: kept\n" && plain.report === "",
    JSON.stringify(plain),
  );
});

suite.test("checkObservation holds the phase, the message pin, and each outcome's fields", () => {
  const depth: Expectation = {
    expect: ["ok", "trap:stack"],
    stage: "compiler",
    diagnostics: 0,
    outputs: { cpp: 2, rust: 1, zig: 1 },
  };
  const pinned: Expectation = {
    expect: "validation",
    message: "is not a directory in files",
  };
  const cases: [string, Expectation, Observation, number][] = [
    [
      "a factory that rejected the module set",
      { expect: "validation" },
      { outcome: "validation", phase: "factory", message: "x" },
      1,
    ],
    [
      "the factory's memory ceiling",
      { expect: "validation:memoryPages" },
      { outcome: "validation:memoryPages", phase: "factory" },
      0,
    ],
    [
      "a pinned message that is present",
      pinned,
      {
        outcome: "validation",
        phase: "job",
        message: "importPath is not a directory in files: nope",
      },
      0,
    ],
    [
      "a harness TypeError on a pinned row",
      pinned,
      {
        outcome: "validation",
        phase: "job",
        message: "Cannot read properties of undefined (reading 'compile')",
      },
      1,
    ],
    [
      "a depth row that compiled with every output",
      depth,
      { outcome: "ok", diagnostics: 0, outputs: { cpp: 2, rust: 1, zig: 1 } },
      0,
    ],
    [
      "a depth row that compiled and published nothing",
      depth,
      { outcome: "ok", diagnostics: 3, outputs: {} },
      2,
    ],
    [
      "a depth row that ran out of stack in the compiler",
      depth,
      { outcome: "trap:stack", stage: "compiler", stderr: false },
      0,
    ],
    [
      "a depth row that ran out of stack in a generator",
      depth,
      { outcome: "trap:stack", stage: "cpp", stderr: true },
      1,
    ],
  ];
  for (const [label, expectation, observation, count] of cases) {
    const mismatches = checkObservation(expectation, observation);
    assert(
      mismatches.length === count,
      `${label}: ${JSON.stringify(mismatches)}, expected ${count} mismatches`,
    );
  }
});

suite.test("validateExpected requires a message pin on bare validation rows", async () => {
  const expected = await loadExpected(root);
  const names = (await loadCases(root)).map((spec) => spec.name);
  const unpinned: ExpectedFile = structuredClone(expected);
  unpinned.cases["missing-import-root"] = { expect: "validation" };
  const problems = validateExpected(unpinned, names);
  assert(
    problems.includes(
      "missing-import-root: a bare validation row needs a message pin",
    ),
    JSON.stringify(problems),
  );
  const override: ExpectedFile = structuredClone(expected);
  override.cases["path-4097"].surfaces = {
    go: { expect: "validation", reason: "r", finding: "f" },
  };
  assert(
    validateExpected(override, names).includes(
      "path-4097/go: a bare validation row needs a message pin",
    ),
    "an override without a pin passed",
  );
});

suite.test("validateExpected rejects fields no accepted outcome reads", async () => {
  const expected = await loadExpected(root);
  const names = (await loadCases(root)).map((spec) => spec.name);
  const clean = validateExpected(expected, names);
  assert(clean.length === 0, JSON.stringify(clean));
  const edited: ExpectedFile = structuredClone(expected);
  edited.cases["const-chain-4000"].outputs = {};
  edited.cases["const-chain-25"].stage = "compiler";
  edited.cases["compiler-trap"].surfaces = {
    ...edited.cases["compiler-trap"].surfaces,
    go: { diagnostics: 0, reason: "r" },
  };
  edited.cases["import-chain-100"].surfaces!["studio@webkit"] = {
    expect: "trap:stack",
    stage: "compiler",
    outputs: { cpp: 2 },
    reason: "r",
    finding: "f",
  };
  const problems = validateExpected(edited, names);
  for (
    const problem of [
      "const-chain-4000: the row accepts no success, so outputs is never checked",
      "const-chain-25: the row accepts no failure, so stage is never checked",
      "compiler-trap/go: the row accepts no success, so diagnostics is never checked",
      "import-chain-100/studio@webkit: the row accepts no success, so outputs is never checked",
    ]
  ) {
    assert(
      problems.includes(problem),
      `${problem}: ${JSON.stringify(problems)}`,
    );
  }
});

suite.test("validateExpected requires a stage for a guest failure and outputs for ok", async () => {
  const expected = await loadExpected(root);
  const names = (await loadCases(root)).map((spec) => spec.name);
  const edited: ExpectedFile = structuredClone(expected);
  // The 1c66d73 WebKit shape: both outcomes and none of the reference's pins.
  edited.cases["const-chain-100"].surfaces!["browser-worker@webkit"] = {
    expect: ["ok", "trap:stack"],
    reason: "r",
    finding: "f",
  };
  // A failure override that drops the reference's stage.
  edited.cases["const-chain-4000"].surfaces!["launcher"] = {
    expect: "trap",
    reason: "r",
    finding: "f",
  };
  // An override with the failure's stage but not the success's outputs.
  edited.cases["import-chain-100"].surfaces!["studio@webkit"] = {
    expect: ["ok", "trap:stack"],
    stage: "compiler",
    diagnostics: 0,
    reason: "r",
    finding: "f",
  };
  const problems = validateExpected(edited, names);
  const wanted = [
    "const-chain-100/browser-worker@webkit: the row accepts trap:stack but pins no stage",
    "const-chain-100/browser-worker@webkit: the row accepts ok but pins no outputs",
    "const-chain-4000/launcher: the row accepts trap but pins no stage",
    "import-chain-100/studio@webkit: the row accepts ok but pins no outputs",
  ];
  assert(
    JSON.stringify(problems.toSorted()) === JSON.stringify(wanted.toSorted()),
    JSON.stringify(problems),
  );
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
