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
// The TypeScript classification reads the error class, the phase that threw,
// and the innermost cause: the engine's or the host's own error, whose name
// and message survive the worker protocol. It never reads guest stderr (the
// SDK appends that to its wrapper messages), so a guest cannot steer it. When
// CompileError gains `kind` and `limit`, those fields replace the class-based
// split into exit, limit, trap, and protocol without changing an expectation;
// trap:stack and policy:output-name stay derived from the innermost cause,
// because the planned kinds cannot express them.

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
  /**
   * Where a TypeScript rejection came from: the factory (createCompiler or
   * createWorkerCompiler) or the job. Only one corpus row may fail in the
   * factory: validation:memoryPages.
   */
  phase?: "factory" | "job";
  /** The failure's own message, for rows that pin one. */
  message?: string;
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

/**
 * An engine's own report of an exhausted stack: V8 and JavaScriptCore raise a
 * RangeError, SpiderMonkey an InternalError.
 */
export function isStackExhaustion(name: string, message: string): boolean {
  return (name === "RangeError" &&
    /^Maximum call stack size exceeded\.?$/.test(message)) ||
    (name === "InternalError" && message === "too much recursion");
}

/** The two CompileErrors the SDK raises when a guest exits 0 against its contract. */
const protocolMessage =
  /^(compiler emitted no request|\w+ generator unexpectedly wrote to stdout)$/;

/** The outcome word for a TypeScript SDK rejection. */
export function classifyError(summary: ErrorSummary): string {
  if (summary.name === "TimeoutError" || summary.name === "AbortError") {
    return "timeout";
  }
  if (summary.isTypeError) {
    const budget = /exceeds (\w+) limit$/.exec(summary.message);
    return budget ? `validation:${budget[1]}` : "validation";
  }
  if (!summary.isCompileError) return `error:${summary.name}`;
  if (summary.exitCode !== undefined) return `exit(${summary.exitCode})`;
  // The innermost cause is the engine's or the host's own error; the wrappers
  // above it carry the guest's stderr in their messages.
  const cause = summary.chain.at(-1);
  if (!cause) {
    return protocolMessage.test(summary.message)
      ? "protocol"
      : "error:CompileError";
  }
  if (cause.name === "LimitError") {
    const limit = /^(\w+) resource limit exceeded$/.exec(cause.message);
    return limit ? `limit:${limit[1]}` : "error:LimitError";
  }
  if (cause.name === "TypeError") {
    // Output collection bounds each generated path after a zero exit.
    const limit = /^path exceeds (\w+) limit$/.exec(cause.message);
    return limit ? `limit:${limit[1]}` : "error:TypeError";
  }
  if (
    cause.name === "Error" &&
    cause.message.startsWith("invalid filesystem entry name: ")
  ) return "policy:output-name";
  if (cause.name === "RuntimeError") return "trap";
  if (isStackExhaustion(cause.name, cause.message)) return "trap:stack";
  return `error:${cause.name}`;
}

export function isErrorSummary(
  summary: ErrorSummary | ResultSummary,
): summary is ErrorSummary {
  return "name" in summary;
}

/** The observation for a TypeScript SDK result or rejection. */
export function observe(
  summary: ErrorSummary | ResultSummary,
  phase: "factory" | "job" = "job",
): Observation {
  if (!isErrorSummary(summary)) {
    return {
      outcome: "ok",
      phase,
      diagnostics: summary.diagnostics.length,
      outputs: summary.outputs,
    };
  }
  const outcome = classifyError(summary);
  const cause = summary.chain.at(-1);
  const observation: Observation = {
    outcome,
    phase,
    message: summary.message,
    detail: `${phase === "factory" ? "factory " : ""}${summary.name}: ${
      summary.message.slice(0, 200)
    }${
      cause
        ? ` [innermost cause ${cause.name}: ${cause.message.slice(0, 120)}]`
        : ""
    }`,
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
  /** Text the failure's own message must contain. */
  message?: string;
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

/** The browser engines a `<surface>@<engine>` key can name. */
export const engineNames = ["chromium", "firefox", "webkit"] as const;

export interface CaseExpectation extends Expectation {
  /** Keyed by surface, or by `<surface>@<engine>` for one browser engine. */
  surfaces?: Record<string, SurfaceOverride>;
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
  engine?: string,
): { skip: string } | Expectation {
  const entry = expected.cases[name];
  if (!entry) throw new Error(`expected.json has no entry for ${name}`);
  const override =
    (engine !== undefined
      ? entry.surfaces?.[`${surface}@${engine}`]
      : undefined) ?? entry.surfaces?.[surface];
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

/** Failures a guest stage produced, so the stage that failed is known. */
const guestFailure =
  /^(trap(:stack)?|exit\(\d+\)|limit:\w+|protocol|policy:[\w-]+)$/;

/**
 * The field problems of one effective expectation (the reference, or what an
 * override leaves of it). A field checkObservation never reads for the
 * outcomes the row accepts: stage and stderr describe a failure, diagnostics
 * and outputs a success. A pin an accepted outcome needs: a guest failure
 * names its stage and ok names its outputs, so an override that replaces the
 * reference cannot drop them unseen.
 */
function fieldProblems(expectation: Expectation): string[] {
  const words = Array.isArray(expectation.expect)
    ? expectation.expect
    : [expectation.expect];
  const problems: string[] = [];
  if (!words.includes("ok")) {
    for (const field of ["diagnostics", "outputs"] as const) {
      if (expectation[field] !== undefined) {
        problems.push(
          `the row accepts no success, so ${field} is never checked`,
        );
      }
    }
  }
  if (words.every((word) => word === "ok")) {
    for (const field of ["stage", "stderr"] as const) {
      if (expectation[field] !== undefined) {
        problems.push(
          `the row accepts no failure, so ${field} is never checked`,
        );
      }
    }
  }
  const failure = words.find((word) => guestFailure.test(word));
  if (failure !== undefined && expectation.stage === undefined) {
    problems.push(`the row accepts ${failure} but pins no stage`);
  }
  if (words.includes("ok") && expectation.outputs === undefined) {
    problems.push("the row accepts ok but pins no outputs");
  }
  return problems;
}

/**
 * Structural checks on expected.json against the corpus: every case has an
 * entry, every entry names a case, outcomes use the vocabulary, every
 * departure carries a reason (and a finding when it changes the outcome), and
 * every effective expectation sets no field its accepted outcomes never read
 * and pins the stage of a guest failure and the outputs of ok.
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
    // Any TypeError is `validation`, so a bare validation row must pin the
    // message, or a harness bug would pass it.
    if (words.includes("validation") && entry.message === undefined) {
      problems.push(`${name}: a bare validation row needs a message pin`);
    }
    const { surfaces: _surfaces, ...reference } = entry;
    for (const problem of fieldProblems(reference)) {
      problems.push(`${name}: ${problem}`);
    }
    for (const [surface, override] of Object.entries(entry.surfaces ?? {})) {
      const [base, engine] = surface.split("@");
      if (
        !surfaces.includes(base as Surface) ||
        (engine !== undefined &&
          (!engineNames.includes(engine as typeof engineNames[number]) ||
            !base.startsWith("browser-") && base !== "studio"))
      ) {
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
        if (
          overrides.includes("validation") && override.message === undefined
        ) {
          problems.push(
            `${name}/${surface}: a bare validation row needs a message pin`,
          );
        }
      }
      const effective = expectationFor(
        expected,
        name,
        base as Surface,
        engine,
      );
      if (!("skip" in effective)) {
        for (const problem of fieldProblems(effective)) {
          problems.push(`${name}/${surface}: ${problem}`);
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
  if (
    observation.phase === "factory" &&
    observation.outcome !== "validation:memoryPages"
  ) {
    mismatches.push(
      `the factory rejected the module set (${observation.detail}); only validation:memoryPages may fail there`,
    );
  }
  if (
    expectation.message !== undefined &&
    !observation.message?.includes(expectation.message)
  ) {
    mismatches.push(
      `the message ${JSON.stringify(observation.message)} lacks ${
        JSON.stringify(expectation.message)
      }`,
    );
  }
  if (!accepted.includes(observation.outcome)) {
    mismatches.push(
      `outcome ${observation.outcome}, expected ${accepted.join(" or ")}${
        observation.detail ? ` (${observation.detail})` : ""
      }`,
    );
  }
  // A row that accepts both a success and a failure (a depth near a stack
  // limit) describes each: stage and stderr apply to the failure, outputs and
  // diagnostics to the success.
  if (observation.outcome !== "ok") {
    if (
      expectation.stage !== undefined &&
      observation.stage !== expectation.stage
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
  } else {
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
      const wanted = JSON.stringify(
        Object.entries(expectation.outputs).sort(),
      );
      if (actual !== wanted) {
        mismatches.push(`outputs ${actual}, expected ${wanted}`);
      }
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
