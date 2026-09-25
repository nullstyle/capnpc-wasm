// Runs the corpus on the TypeScript SDK in Deno: the direct compiler on the
// pinned Deno, the worker compiler on the supported worker runtime. Shared by
// sdk/typescript/conformance_test.ts and tests/conformance/conformance_test.ts.

import {
  CompileError,
  createCompiler,
  createWorkerCompiler,
  type Modules,
} from "../../sdk/typescript/mod.ts";
import {
  type CaseSpec,
  expandCase,
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
  type ExpectedFile,
  loadExpected,
  type Observation,
  observe,
  type Surface,
} from "./outcome.ts";
import { cachingHost, orderCases, runCase } from "./page-runner.js";

const root = new URL("../../", import.meta.url);
const workerURL = new URL("../../sdk/typescript/worker.ts", import.meta.url);

/** The corpus and the real modules, loaded once per process. */
export interface Corpus {
  cases: CaseSpec[];
  expected: ExpectedFile;
  guests: Record<string, Uint8Array>;
  modules: Modules;
  /** The request a compile of simpleSchema produces on this surface. */
  valid: Uint8Array;
}

let corpusPromise: Promise<Corpus> | undefined;

export function loadCorpus(): Promise<Corpus> {
  return corpusPromise ??= (async () => {
    const read = (path: string) => Deno.readFile(new URL(path, root));
    const [compiler, cpp, rust, go, zig] = await Promise.all([
      read("build/wasm/bin/capnp.wasm"),
      read("build/wasm/bin/capnpc-c++.wasm"),
      read("build/wasm/bin/capnpc-rust.wasm"),
      read("build/wasm/bin/capnpc-go.wasm"),
      read("build/wasm/bin/capnpc-zig.wasm"),
    ]);
    const modules: Modules = { compiler, generators: { cpp, rust, go, zig } };
    const direct = await createCompiler({ compiler, generators: {} });
    const { request } = await direct.compile({
      files: { "a.capnp": simpleSchema },
      entrypoints: ["a.capnp"],
      generators: [],
    });
    return {
      cases: await loadCases(root),
      expected: await loadExpected(root),
      guests: await loadGuests(root),
      modules,
      valid: request,
    };
  })();
}

/** One row of the observed matrix. */
export interface Row {
  name: string;
  surface: Surface;
  observation?: Observation;
  skipped?: string;
  mismatches: string[];
}

/**
 * Run every case the surface can express, as one test step each, in the
 * shared orderCases() order. Returns the observed rows in corpus order; a
 * mismatch fails its step.
 */
export async function runTsSurface(
  t: Deno.TestContext,
  surface: "ts-direct" | "ts-worker",
): Promise<Row[]> {
  const corpus = await loadCorpus();
  const readStandard = standardReader(root);
  const host = cachingHost({
    CompileError,
    create: (modules, options) =>
      surface === "ts-direct"
        ? createCompiler(modules, options)
        : createWorkerCompiler(workerURL, modules, options),
    jobOptions: (spec) =>
      surface === "ts-worker" && spec.deadlineMs
        ? { timeoutMs: spec.deadlineMs }
        : undefined,
  });
  const rows: Row[] = [];
  try {
    for (const spec of orderCases(corpus.cases)) {
      const expectation = expectationFor(corpus.expected, spec.name, surface);
      if ("skip" in expectation) {
        rows.push({
          name: spec.name,
          surface,
          skipped: expectation.skip,
          mismatches: [],
        });
        continue;
      }
      await t.step(spec.name, async () => {
        const workspace = spec.op === "compile"
          ? await expandCase(spec, readStandard)
          : { files: {}, includeFiles: {} };
        const inputs = {
          ...workspace,
          request: spec.request
            ? requestVariant(spec.request, corpus.valid)
            : undefined,
        };
        const { phase, summary } = await runCase(
          spec,
          inputs,
          host,
          corpus.modules,
          corpus.guests,
        );
        const observation = observe(summary, phase);
        const mismatches = checkObservation(expectation, observation);
        rows.push({ name: spec.name, surface, observation, mismatches });
        if (
          Array.isArray(expectation.expect) && expectation.expect.length > 1
        ) {
          console.log(
            `OBSERVED ${surface} ${spec.name}: ${
              describeObservation(observation)
            } (accepts ${expectation.expect.join(" or ")})`,
          );
        }
        if (mismatches.length > 0) {
          throw new Error(
            `${surface} ${spec.name}: ${mismatches.join("; ")} [observed ${
              describeObservation(observation)
            }]`,
          );
        }
      });
    }
  } finally {
    host.disposeAll();
  }
  const position = new Map(
    corpus.cases.map((spec, index) => [spec.name, index]),
  );
  return rows.sort((a, b) => position.get(a.name)! - position.get(b.name)!);
}
