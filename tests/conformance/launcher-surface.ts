// Runs the corpus through the packaged Wasmtime launcher (bin/capnp-wasm):
// compile cases stage their workspace as the launcher's read-only root, the
// generation cases feed the request on stdin, compiler guests run as generator
// modules (compiler mode cannot swap the compiler), and deadline rows use
// CAPNP_WASM_TIMEOUT. Called from tests/package/launcher.ts for every packaged
// launcher the package gates exercise.

import {
  type CaseSpec,
  expandCase,
  type Language,
  loadCases,
  requestVariant,
  simpleSchema,
  standardReader,
} from "./cases.ts";
import { loadGuests } from "./guests.ts";
import {
  checkObservation,
  describeObservation,
  expectationFor,
  loadExpected,
  type Observation,
  stackExhausted,
} from "./outcome.ts";

export interface LauncherSurface {
  /** The command that runs the packaged launcher, for example `bash <path>`. */
  launcher: readonly string[];
  /** The directory holding the generator modules (`capnpc-c++.wasm`, ...). */
  modules: string;
  /** A directory the runner may create its work directory in. */
  scratch: string;
}

const commands: Record<Language, string> = {
  cpp: "capnpc-c++",
  rust: "capnpc-rust",
  go: "capnpc-go",
  zig: "capnpc-zig",
};

/** Wasmtime's own trap report, which follows whatever the guest wrote. */
const runtimeReport = "Error: failed to run main module";

interface Step {
  stage: string;
  code: number | null;
  signal: string | null;
  stdout: Uint8Array;
  /** The guest's stderr, without the runtime's trap report. */
  stderr: string;
  /** The complete stderr, for classification and messages. */
  fullStderr: string;
  published: number;
}

async function run(
  args: readonly string[],
  input: Uint8Array | undefined,
  env: Record<string, string>,
): Promise<Deno.CommandOutput> {
  const child = new Deno.Command(args[0], {
    args: args.slice(1),
    env,
    stdin: input ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(120_000),
  }).spawn();
  const output = child.output();
  if (input) {
    try {
      await new Blob([new Uint8Array(input)]).stream().pipeTo(child.stdin);
    } catch (error) {
      if (!(error instanceof Deno.errors.BrokenPipe)) throw error;
    }
  }
  return await output;
}

async function countFiles(directory: string): Promise<number> {
  let count = 0;
  for await (const entry of Deno.readDir(directory)) {
    count += entry.isDirectory
      ? await countFiles(`${directory}/${entry.name}`)
      : 1;
  }
  return count;
}

async function writeTree(
  directory: string,
  entries: Record<string, Uint8Array>,
): Promise<void> {
  for (const [path, bytes] of Object.entries(entries)) {
    const target = `${directory}/${path}`;
    await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeFile(target, bytes);
  }
}

function classify(step: Step): string {
  if (step.signal) return `signal:${step.signal}`;
  if (step.code === 0) return "ok";
  if (step.code === 134) {
    if (/wasm trap: interrupt/.test(step.fullStderr)) return "timeout";
    if (stackExhausted.test(step.fullStderr)) return "trap:stack";
    return "trap";
  }
  return `exit(${step.code})`;
}

export interface LauncherRow {
  name: string;
  observation?: Observation;
  skipped?: string;
  mismatches: string[];
}

/**
 * Run every case the launcher expresses and check it against the "launcher"
 * surface of expected.json. Throws after the whole corpus ran when any row
 * mismatched, naming each one.
 */
export async function runLauncherConformance(
  surface: LauncherSurface,
): Promise<LauncherRow[]> {
  const root = new URL("../../", import.meta.url);
  const [cases, expected, guests] = await Promise.all([
    loadCases(root),
    loadExpected(root),
    loadGuests(root),
  ]);
  const readStandard = standardReader(root);
  const work = await Deno.realPath(
    await Deno.makeTempDir({ dir: surface.scratch, prefix: "conformance-" }),
  );
  const guestDirectory = `${work}/guests`;
  await Deno.mkdir(guestDirectory);
  for (const [name, bytes] of Object.entries(guests)) {
    await Deno.writeFile(`${guestDirectory}/${name}.wasm`, bytes);
  }
  const decoder = new TextDecoder();
  let sequence = 0;

  async function step(
    stage: string,
    args: readonly string[],
    input: Uint8Array | undefined,
    env: Record<string, string>,
    output?: string,
  ): Promise<Step> {
    const result = await run([...surface.launcher, ...args], input, env);
    const fullStderr = decoder.decode(result.stderr);
    const report = fullStderr.indexOf(runtimeReport);
    return {
      stage,
      code: result.signal ? null : result.code,
      signal: result.signal,
      stdout: result.stdout,
      stderr: report >= 0 ? fullStderr.slice(0, report) : fullStderr,
      fullStderr,
      published: output ? await countFiles(output) : 0,
    };
  }

  async function generate(
    spec: CaseSpec,
    language: Language,
    request: Uint8Array,
    env: Record<string, string>,
  ): Promise<Step> {
    const guest = spec.generatorGuests?.[language];
    const module = guest
      ? `${guestDirectory}/${guest}.wasm`
      : `${surface.modules}/${commands[language]}.wasm`;
    const output = `${work}/${++sequence}-${language}`;
    await Deno.mkdir(output);
    return await step(
      language,
      ["generator", "--module", module, "--output", output, "--"],
      request,
      env,
      output,
    );
  }

  /** The launcher's own compile of the one-struct schema: the valid request. */
  const validWorkspace = `${work}/valid`;
  await writeTree(`${validWorkspace}/src`, {
    "a.capnp": new TextEncoder().encode(simpleSchema),
  });
  await Deno.mkdir(`${validWorkspace}/include`);
  const valid = await step(
    "compiler",
    [
      "compiler",
      "--workspace",
      validWorkspace,
      "--",
      "compile",
      "--no-standard-import",
      "-I/include",
      "--src-prefix=/src",
      "-o-",
      "/src/a.capnp",
    ],
    undefined,
    {},
  );
  if (valid.code !== 0 || valid.stdout.length === 0) {
    throw new Error(
      `the launcher could not compile the valid request: ${valid.fullStderr}`,
    );
  }

  const rows: LauncherRow[] = [];
  for (const spec of cases) {
    const expectation = expectationFor(expected, spec.name, "launcher");
    if ("skip" in expectation) {
      rows.push({ name: spec.name, skipped: expectation.skip, mismatches: [] });
      continue;
    }
    const env: Record<string, string> = spec.deadlineMs
      ? {
        CAPNP_WASM_TIMEOUT: String(
          Math.max(1, Math.ceil(spec.deadlineMs / 1000)),
        ),
      }
      : {};
    const steps: Step[] = [];
    let request: Uint8Array | undefined;
    if (spec.op === "compile") {
      if (spec.compiler) {
        // The compiler guest runs as a generator module with an empty root.
        const output = `${work}/${++sequence}-compiler`;
        await Deno.mkdir(output);
        steps.push(
          await step(
            "compiler",
            [
              "generator",
              "--module",
              `${guestDirectory}/${spec.compiler}.wasm`,
              "--output",
              output,
              "--",
            ],
            undefined,
            env,
            output,
          ),
        );
      } else {
        const workspace = await expandCase(spec, readStandard);
        const directory = `${work}/${++sequence}-workspace`;
        await writeTree(`${directory}/src`, workspace.files);
        await Deno.mkdir(`${directory}/include`, { recursive: true });
        await writeTree(`${directory}/include`, workspace.includeFiles);
        steps.push(
          await step(
            "compiler",
            [
              "compiler",
              "--workspace",
              directory,
              "--",
              "compile",
              "--no-standard-import",
              ...(spec.importPaths ?? []).map((path) =>
                path ? `-I/src/${path}` : "-I/src"
              ),
              "-I/include",
              "--src-prefix=/src",
              ...(spec.sourcePrefix
                ? [`--src-prefix=/src/${spec.sourcePrefix}`]
                : []),
              "-o-",
              ...spec.entrypoints!.map((path) => `/src/${path}`),
            ],
            undefined,
            env,
          ),
        );
        request = steps[0].stdout;
      }
    } else {
      request = requestVariant(spec.request!, valid.stdout);
    }
    if (steps.length === 0 || steps[0].code === 0) {
      for (const language of spec.generators) {
        const generated = await generate(spec, language, request!, env);
        steps.push(generated);
        if (generated.code !== 0) break;
      }
    }
    const failed = steps.find((entry) => entry.code !== 0);
    const observation: Observation = failed
      ? {
        outcome: classify(failed),
        stage: failed.stage,
        stderr: failed.stderr.length > 0,
        detail: `exit ${failed.code ?? failed.signal}: ${
          failed.fullStderr.slice(0, 200).replace(/\n/g, " ")
        }`,
      }
      : {
        outcome: "ok",
        diagnostics: steps.filter((entry) => entry.stderr.length > 0).length,
        outputs: Object.fromEntries(
          steps.filter((entry) => entry.stage !== "compiler").map((
            entry,
          ) => [entry.stage, entry.published]),
        ),
      };
    const mismatches = checkObservation(expectation, observation);
    if (failed && failed.published > 0) {
      mismatches.push(
        `${failed.published} files published after the ${failed.stage} stage failed`,
      );
    }
    rows.push({ name: spec.name, observation, mismatches });
  }
  const failures = rows.filter((row) => row.mismatches.length > 0);
  if (failures.length > 0) {
    throw new Error(
      `launcher conformance: ${failures.length} of ${
        rows.length - rows.filter((row) => row.skipped).length
      } rows differ from tests/fixtures/conformance/expected.json:\n${
        failures.map((row) =>
          `  ${row.name}: ${row.mismatches.join("; ")} [observed ${
            describeObservation(row.observation!)
          }]`
        ).join("\n")
      }`,
    );
  }
  return rows;
}
