// The normalized outcome vocabulary shared by every conformance runner, the
// classification of TypeScript SDK results into it, and the expectation table
// in tests/fixtures/conformance/expected.json.
//
// Outcomes:
//   ok                 the job succeeded
//   validation[:limit] caller input rejected before any guest started; a
//                      budget names the limit (`validation:pathBytes`)
//   exit(n)            a guest exited with status n
//   trap               a guest trapped (unreachable, memory fault, ...)
//   trap:stack         a guest exhausted the call stack
//   limit:<budget>     a running guest exceeded a ResourceLimits budget
//   policy:<rule>      the host refused a result by policy (output-name)
//   protocol           a guest exited 0 without honoring its contract
//   timeout            the host deadline stopped the job
//
// The TypeScript classification reads the error class and message (and the
// cause chain), which is what the SDK exposes today. When CompileError gains
// `kind` and `limit`, classifyError switches to those fields without changing
// a single expectation.

export type Surface =
  | "ts-direct"
  | "ts-worker"
  | "go"
  | "launcher"
  | "browser-direct"
  | "browser-worker"
  | "studio";

export const surfaces: readonly Surface[] = [
  "ts-direct",
  "ts-worker",
  "go",
  "launcher",
  "browser-direct",
  "browser-worker",
  "studio",
];

/** A structured-cloneable account of a rejection, from any TypeScript surface. */
export interface ErrorSummary {
  name: string;
  message: string;
  isCompileError: boolean;
  isTypeError: boolean;
  stage?: string;
  exitCode?: number;
  diagnostics: { stage: string; stderrBytes: number }[];
  hasOutputs: boolean;
  /** name and message of each `cause`, outermost first. */
  chain: { name: string; message: string }[];
}

/** A structured-cloneable account of a result. */
export interface ResultSummary {
  outputs: Record<string, number>;
  diagnostics: { stage: string; stderrBytes: number }[];
  requestBytes?: number;
}

/** What a runner observed for one case on one surface. */
export interface Observation {
  outcome: string;
  /** The failing stage, when the outcome is a guest failure. */
  stage?: string;
  /** Whether the failing stage wrote stderr. */
  stderr?: boolean;
  /** Diagnostic entries on success. */
  diagnostics?: number;
  /** Files per language on success. */
  outputs?: Record<string, number>;
  /** Free text for failure messages. */
  detail?: string;
}

export const stackExhausted =
  /Maximum call stack size exceeded|too much recursion|call stack exhausted|stack overflow/i;

const protocolMessages = [
  "compiler emitted no request",
  "generator unexpectedly wrote to stdout",
];

/** The outcome word for a TypeScript SDK rejection. */
export function classifyError(summary: ErrorSummary): string {
  if (summary.name === "TimeoutError" || summary.name === "AbortError") {
    return "timeout";
  }
  if (summary.isTypeError) {
    const budget = /exceeds (\w+) limit/.exec(summary.message);
    return budget ? `validation:${budget[1]}` : "validation";
  }
  if (!summary.isCompileError) return `error:${summary.name}`;
  if (summary.exitCode !== undefined) return `exit(${summary.exitCode})`;
  const texts = [summary.message, ...summary.chain.map((link) => link.message)];
  for (const text of texts) {
    const limit = /(\w+) resource limit exceeded/.exec(text) ??
      /exceeds (\w+) limit/.exec(text);
    if (limit) return `limit:${limit[1]}`;
  }
  if (texts.some((text) => text.includes("invalid filesystem entry name"))) {
    return "policy:output-name";
  }
  if (protocolMessages.some((message) => summary.message.includes(message))) {
    return "protocol";
  }
  if (texts.some((text) => stackExhausted.test(text))) return "trap:stack";
  return "trap";
}

export function isErrorSummary(
  summary: ErrorSummary | ResultSummary,
): summary is ErrorSummary {
  return "name" in summary;
}

/** The observation for a TypeScript SDK result or rejection. */
export function observe(summary: ErrorSummary | ResultSummary): Observation {
  if (!isErrorSummary(summary)) {
    return {
      outcome: "ok",
      diagnostics: summary.diagnostics.length,
      outputs: summary.outputs,
    };
  }
  const outcome = classifyError(summary);
  const observation: Observation = {
    outcome,
    detail: `${summary.name}: ${summary.message.slice(0, 200)}`,
  };
  if (summary.isCompileError) {
    observation.stage = summary.stage;
    observation.stderr = summary.diagnostics.some((entry) =>
      entry.stage === summary.stage && entry.stderrBytes > 0
    );
    if (summary.hasOutputs) {
      observation.detail += " (the error exposes outputs)";
      observation.outcome = `${outcome}+outputs`;
    }
  }
  return observation;
}

export interface Expectation {
  /** The outcome, or the outcomes an engine-dependent row may produce. */
  expect: string | string[];
  stage?: string;
  /** The failing stage must (true) or must not (false) have written stderr. */
  stderr?: boolean;
  /** Diagnostic entries a successful job carries. */
  diagnostics?: number;
  /** Files per language a successful job returns. */
  outputs?: Record<string, number>;
}

/** A surface's departure from the reference expectation, with its reason. */
export interface SurfaceOverride extends Partial<Expectation> {
  /** The surface cannot express the case; the reason. */
  skip?: string;
  /** Why the surface differs. */
  reason?: string;
  /** The finding or decision that records the difference. */
  finding?: string;
}

export interface CaseExpectation extends Expectation {
  surfaces?: Partial<Record<Surface, SurfaceOverride>>;
}

export interface ExpectedFile {
  vocabulary: Record<string, string>;
  surfaces: Record<Surface, string>;
  cases: Record<string, CaseExpectation>;
}

export const expectedPath = "tests/fixtures/conformance/expected.json";

export async function loadExpected(root: string | URL): Promise<ExpectedFile> {
  return JSON.parse(await Deno.readTextFile(new URL(expectedPath, root)));
}

/**
 * The expectation for one case on one surface, or the reason it is skipped.
 * An override that changes the outcome replaces the whole expectation (its
 * stage, stderr, diagnostics, and outputs describe that outcome); one that
 * keeps the outcome adjusts the reference's fields.
 */
export function expectationFor(
  expected: ExpectedFile,
  name: string,
  surface: Surface,
): { skip: string } | Expectation {
  const entry = expected.cases[name];
  if (!entry) throw new Error(`expected.json has no entry for ${name}`);
  const override = entry.surfaces?.[surface];
  if (override?.skip) return { skip: override.skip };
  const { surfaces: _surfaces, ...reference } = entry;
  if (!override) return reference;
  const { reason: _reason, finding: _finding, ...fields } = override;
  return fields.expect !== undefined
    ? fields as Expectation
    : { ...reference, ...fields };
}

const outcomeWord =
  /^(ok|validation(:\w+)?|exit\(\d+\)|trap(:stack)?|limit:\w+|policy:[\w-]+|protocol|timeout)$/;

/**
 * Structural checks on expected.json against the corpus: every case has an
 * entry, every entry names a case, outcomes use the vocabulary, and every
 * departure carries a reason (and a finding when it changes the outcome).
 */
export function validateExpected(
  expected: ExpectedFile,
  caseNames: readonly string[],
): string[] {
  const problems: string[] = [];
  const names = new Set(caseNames);
  for (const name of caseNames) {
    if (!expected.cases[name]) problems.push(`${name}: no expectation`);
  }
  for (const [name, entry] of Object.entries(expected.cases)) {
    if (!names.has(name)) problems.push(`${name}: not in the corpus`);
    const words = Array.isArray(entry.expect) ? entry.expect : [entry.expect];
    for (const word of words) {
      if (!outcomeWord.test(word)) problems.push(`${name}: outcome ${word}`);
    }
    for (const [surface, override] of Object.entries(entry.surfaces ?? {})) {
      if (!surfaces.includes(surface as Surface)) {
        problems.push(`${name}: unknown surface ${surface}`);
      }
      if (override.skip !== undefined) {
        if (typeof override.skip !== "string" || override.skip.length === 0) {
          problems.push(`${name}/${surface}: skip needs a reason`);
        }
        continue;
      }
      if (!override.reason) {
        problems.push(`${name}/${surface}: departure needs a reason`);
      }
      if (override.expect !== undefined) {
        if (!override.finding) {
          problems.push(
            `${name}/${surface}: a different outcome needs a finding`,
          );
        }
        const overrides = Array.isArray(override.expect)
          ? override.expect
          : [override.expect];
        for (const word of overrides) {
          if (!outcomeWord.test(word)) {
            problems.push(`${name}/${surface}: outcome ${word}`);
          }
        }
      }
    }
  }
  return problems;
}

/** The mismatches between an expectation and an observation, or none. */
export function checkObservation(
  expectation: Expectation,
  observation: Observation,
): string[] {
  const mismatches: string[] = [];
  const accepted = Array.isArray(expectation.expect)
    ? expectation.expect
    : [expectation.expect];
  if (!accepted.includes(observation.outcome)) {
    mismatches.push(
      `outcome ${observation.outcome}, expected ${accepted.join(" or ")}${
        observation.detail ? ` (${observation.detail})` : ""
      }`,
    );
  }
  if (
    expectation.stage !== undefined && observation.stage !== expectation.stage
  ) {
    mismatches.push(
      `stage ${observation.stage}, expected ${expectation.stage}`,
    );
  }
  if (
    expectation.stderr !== undefined &&
    observation.stderr !== expectation.stderr
  ) {
    mismatches.push(
      expectation.stderr
        ? "the failing stage wrote no stderr"
        : "the failing stage wrote stderr",
    );
  }
  if (
    expectation.diagnostics !== undefined &&
    observation.diagnostics !== expectation.diagnostics
  ) {
    mismatches.push(
      `${observation.diagnostics} diagnostics, expected ${expectation.diagnostics}`,
    );
  }
  if (expectation.outputs !== undefined) {
    const actual = JSON.stringify(
      Object.entries(observation.outputs ?? {}).sort(),
    );
    const wanted = JSON.stringify(Object.entries(expectation.outputs).sort());
    if (actual !== wanted) {
      mismatches.push(`outputs ${actual}, expected ${wanted}`);
    }
  }
  return mismatches;
}

/** One line per case for a runner's log and the observed matrix. */
export function describeObservation(observation: Observation): string {
  const parts = [observation.outcome];
  if (observation.stage) parts.push(`stage=${observation.stage}`);
  if (observation.stderr !== undefined) {
    parts.push(`stderr=${observation.stderr}`);
  }
  if (observation.diagnostics !== undefined) {
    parts.push(`diagnostics=${observation.diagnostics}`);
  }
  if (observation.outputs) {
    parts.push(`outputs=${JSON.stringify(observation.outputs)}`);
  }
  return parts.join(" ");
}
