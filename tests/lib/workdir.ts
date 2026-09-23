// Work directory retention for the Deno test suites. A suite's directories
// under build/test are deleted when the process exits after every test passed,
// kept and printed when any test failed, and always kept when
// CAPNP_KEEP_TEST_DIRS=1 is set (which needs --allow-env for that name).

import { buildTest } from "./paths.ts";
import { envValue } from "./process.ts";

/** True when CAPNP_KEEP_TEST_DIRS=1 asks to keep every work directory. */
export const keepTestDirs = envValue("CAPNP_KEEP_TEST_DIRS") === "1";

export interface TestSuite {
  /** Registers a Deno test; a throw or a failed step retains the work dirs. */
  test(
    name: string,
    fn: (t: Deno.TestContext) => void | Promise<void>,
  ): void;
  /** Creates a fresh `build/test/<prefix><suffix>-XXXX` directory. */
  workDir(suffix?: string): Promise<string>;
  /** Marks the suite failed, for failures reported outside test bodies. */
  markFailed(): void;
}

interface SuiteState {
  prefix: string;
  directories: string[];
  failed: boolean;
}

const suites: SuiteState[] = [];

globalThis.addEventListener("unload", () => {
  for (const suite of suites) {
    for (const directory of suite.directories) {
      if (suite.failed || keepTestDirs) {
        const why = suite.failed ? "after a failure" : "CAPNP_KEEP_TEST_DIRS=1";
        console.error(`tests/lib/workdir: kept ${directory} (${why})`);
        continue;
      }
      try {
        Deno.removeSync(directory, { recursive: true });
      } catch (error) {
        console.error(
          `tests/lib/workdir: could not remove ${directory}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }
});

/** One retention scope per suite file. */
export function testSuite(prefix: string): TestSuite {
  const state: SuiteState = { prefix, directories: [], failed: false };
  suites.push(state);
  const markFailed = () => {
    state.failed = true;
  };
  return {
    markFailed,
    async workDir(suffix = "") {
      await Deno.mkdir(buildTest, { recursive: true });
      const directory = await Deno.makeTempDir({
        dir: buildTest,
        prefix: `${prefix}${suffix}`,
      });
      state.directories.push(directory);
      return directory;
    },
    test(name, fn) {
      Deno.test(name, async (t) => {
        try {
          await fn(trackSteps(t, markFailed));
        } catch (error) {
          markFailed();
          throw error;
        }
      });
    },
  };
}

type StepFn = (t: Deno.TestContext) => void | Promise<void>;

/**
 * A failed step does not throw in the parent (t.step resolves to false), so
 * wrap every step, including nested ones, to record the failure.
 */
function trackSteps(
  t: Deno.TestContext,
  onFailure: () => void,
): Deno.TestContext {
  const wrapFn = (fn: StepFn): StepFn => (inner) =>
    fn(trackSteps(inner, onFailure));
  const step = async (
    first: string | StepFn | Deno.TestStepDefinition,
    second?: StepFn,
  ): Promise<boolean> => {
    let passed: boolean;
    if (typeof first === "string") {
      passed = await t.step(first, wrapFn(second!));
    } else if (typeof first === "function") {
      passed = await t.step(wrapFn(first));
    } else {
      passed = await t.step({ ...first, fn: wrapFn(first.fn) });
    }
    if (!passed) onFailure();
    return passed;
  };
  return { ...t, step: step as Deno.TestContext["step"] };
}
