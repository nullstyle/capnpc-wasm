// The failure and limit conformance corpus in the browsers: the direct
// compiler, the worker compiler, and the Schema Studio adapter each run every
// case they can express through tests/conformance/page-runner.js, and the
// page's summaries are classified and checked here against the surface's
// column of tests/fixtures/conformance/expected.json.
import {
  type CaseSpec,
  expandCase,
  loadCases,
  requestVariant,
  simpleSchema,
  standardReader,
} from "../conformance/cases.ts";
import { loadGuests } from "../conformance/guests.ts";
import {
  checkObservation,
  describeObservation,
  type ErrorSummary,
  expectationFor,
  type ExpectedFile,
  loadExpected,
  type Observation,
  observe,
  type ResultSummary,
  type Surface,
} from "../conformance/outcome.ts";
import { orderCases } from "../conformance/page-runner.js";
import type { Engine } from "./engines.ts";

export type BrowserSurface = "browser-direct" | "browser-worker" | "studio";

export const browserSurfaces: readonly BrowserSurface[] = [
  "browser-direct",
  "browser-worker",
  "studio",
];

export interface BrowserRow {
  name: string;
  surface: Surface;
  observation?: Observation;
  /** The outcomes the row accepts, when it accepts more than one. */
  accepted?: string[];
  skipped?: string;
  mismatches: string[];
}

type Evaluate = <T, A>(
  fn: (argument: A) => Promise<T> | T,
  argument: A,
  label: string,
) => Promise<T>;

/** The corpus as the browser driver needs it, loaded once. */
export interface BrowserCorpus {
  cases: CaseSpec[];
  expected: ExpectedFile;
  guests: Record<string, Uint8Array>;
  readStandard: (name: string) => Promise<Uint8Array>;
}

export async function loadBrowserCorpus(root: URL): Promise<BrowserCorpus> {
  return {
    cases: await loadCases(root),
    expected: await loadExpected(root),
    guests: await loadGuests(root),
    readStandard: standardReader(root),
  };
}

/**
 * Bundle tests/browser/studio-adapter.js for the page with the pinned Deno,
 * as build-studio.ts bundles the application. The output is a browser ES
 * module that exports studioCompiler and the SDK's CompileError.
 */
export async function bundleStudioAdapter(
  root: string,
  output: string,
): Promise<void> {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      "--config",
      `${root}/examples/browser/deno.json`,
      "--frozen",
      "--unstable-sloppy-imports",
      "--platform",
      "browser",
      "--format",
      "esm",
      "-o",
      output,
      `${root}/tests/browser/studio-adapter.js`,
    ],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(120_000),
  }).output();
  if (!result.success) {
    throw new Error(
      `bundling the Studio adapter failed: ${
        new TextDecoder().decode(result.stderr)
      }`,
    );
  }
}

/**
 * Prepare the page: import the shared runner and the Studio adapter bundle,
 * compile the one-struct schema for the request variants, and prime the
 * adapter with every language so its later rows run from memory. Returns the
 * valid request bytes.
 */
export async function setupConformance(
  evaluate: Evaluate,
  guests: Record<string, Uint8Array>,
  label: string,
): Promise<Uint8Array> {
  const valid = await evaluate(
    async ({ guests, simpleSchema }) => {
      type Host = {
        create(modules: unknown, options: unknown): Promise<unknown>;
        jobOptions(spec: { deadlineMs?: number }): unknown;
        CompileError: unknown;
      };
      type Runner = {
        cachingHost(base: Host): unknown;
        runCase(...args: unknown[]): Promise<{ summary: unknown }>;
        runStudioCase(...args: unknown[]): Promise<{ summary: unknown }>;
      };
      const state = (globalThis as unknown as {
        capnpTest: {
          sdk: {
            CompileError: unknown;
            createCompiler(
              modules: unknown,
              options: unknown,
            ): Promise<unknown>;
            createWorkerCompiler(
              url: string,
              modules: unknown,
              options: unknown,
            ): Promise<unknown>;
          };
          direct: {
            compile(job: unknown): Promise<{ request: Uint8Array }>;
          };
          workerURL: string;
          modules: unknown;
        };
      }).capnpTest;
      const runner = await import(
        new URL("/conformance/page-runner.js", location.href).href
      ) as Runner;
      const adapter = await import(
        new URL("/studio/adapter.js", location.href).href
      ) as {
        studioCompiler(base: URL): {
          compile(
            workspace: (standard: Record<string, Uint8Array>) => unknown,
            targets: string[],
            signal: AbortSignal,
            status: () => void,
          ): Promise<{ request: Uint8Array }>;
          generate(
            request: Uint8Array,
            targets: string[],
            signal: AbortSignal,
            status: () => void,
          ): Promise<unknown>;
        };
        CompileError: unknown;
      };
      const studio = adapter.studioCompiler(
        new URL("/studio/assets/", location.href),
      );
      const valid = (await state.direct.compile({
        files: { "a.capnp": simpleSchema },
        entrypoints: ["a.capnp"],
        generators: [],
      })).request;
      // Load every module and include into the adapter while the server is
      // up. Go generation needs the Go annotations, which the corpus schema
      // lacks, so the priming schema carries them.
      const languages = ["cpp", "rust", "go", "zig"];
      const signal = new AbortController().signal;
      const primed = await studio.compile(
        (standard) => ({
          files: {
            "prime.capnp":
              '@0xece4bf9c1f867626;\nusing Go = import "/go.capnp";\n$Go.package("prime");\n$Go.import("example.com/prime");\nstruct Prime { x @0 :UInt8; }\n',
          },
          includeFiles: standard,
          entrypoints: ["prime.capnp"],
          generators: [],
        }),
        languages,
        signal,
        () => {},
      );
      await studio.generate(primed.request, languages, signal, () => {});
      const hosts = {
        "browser-direct": runner.cachingHost({
          CompileError: state.sdk.CompileError,
          create: (modules, options) =>
            state.sdk.createCompiler(modules, options),
          jobOptions: (spec) =>
            spec.deadlineMs ? { timeoutMs: spec.deadlineMs } : undefined,
        }),
        "browser-worker": runner.cachingHost({
          CompileError: state.sdk.CompileError,
          create: (modules, options) =>
            state.sdk.createWorkerCompiler(state.workerURL, modules, options),
          jobOptions: (spec) =>
            spec.deadlineMs ? { timeoutMs: spec.deadlineMs } : undefined,
        }),
      };
      (globalThis as unknown as { capnpConformance: unknown })
        .capnpConformance = {
          runner,
          studio,
          studioCompileError: adapter.CompileError,
          hosts,
          guests,
          modules: state.modules,
        };
      return Array.from(valid);
    },
    { guests, simpleSchema },
    label,
  );
  return new Uint8Array(valid);
}

/** Dispose every client the rows created. */
export async function teardownConformance(
  evaluate: Evaluate,
  label: string,
): Promise<void> {
  await evaluate(
    () => {
      const state = (globalThis as unknown as {
        capnpConformance: {
          hosts: Record<string, { disposeAll(): void }>;
          studio: { dispose(): void };
        };
      }).capnpConformance;
      for (const host of Object.values(state.hosts)) host.disposeAll();
      state.studio.dispose();
    },
    undefined,
    label,
  );
}

/**
 * Run every case the surface expresses, one page step each in the shared
 * orderCases() order (deadline rows last: in WebKit each leaves its guest
 * spinning until the browser closes), and check the page's summary against
 * expected.json. Throws after the whole surface ran when any row mismatched,
 * naming each one; returns the rows in corpus order.
 */
export async function runBrowserSurface(
  engine: Engine,
  surface: BrowserSurface,
  corpus: BrowserCorpus,
  valid: Uint8Array,
  evaluate: Evaluate,
): Promise<BrowserRow[]> {
  const rows: BrowserRow[] = [];
  for (const spec of orderCases(corpus.cases)) {
    const expectation = expectationFor(
      corpus.expected,
      spec.name,
      surface,
      engine,
    );
    if ("skip" in expectation) {
      rows.push({
        name: spec.name,
        surface,
        skipped: expectation.skip,
        mismatches: [],
      });
      continue;
    }
    const workspace = spec.op === "compile"
      ? await expandCase(spec, corpus.readStandard)
      : { files: {}, includeFiles: {} };
    const inputs = {
      ...workspace,
      request: spec.request ? requestVariant(spec.request, valid) : undefined,
    };
    const { phase, summary } = await evaluate(
      async ({ surface, spec, inputs }) => {
        const state = (globalThis as unknown as {
          capnpConformance: {
            runner: {
              runCase(...args: unknown[]): Promise<{ summary: unknown }>;
              runStudioCase(...args: unknown[]): Promise<{ summary: unknown }>;
            };
            studio: unknown;
            studioCompileError: unknown;
            hosts: Record<string, unknown>;
            guests: unknown;
            modules: unknown;
          };
        }).capnpConformance;
        const result = surface === "studio"
          ? await state.runner.runStudioCase(
            spec,
            inputs,
            state.studio,
            state.studioCompileError,
          )
          : await state.runner.runCase(
            spec,
            inputs,
            state.hosts[surface],
            state.modules,
            state.guests,
          );
        return {
          phase: (result as { phase?: "factory" | "job" }).phase ?? "job",
          summary: result.summary as ErrorSummary | ResultSummary,
        };
      },
      { surface, spec, inputs },
      `${engine} ${surface} conformance ${spec.name}`,
    );
    const observation = observe(summary, phase);
    rows.push({
      name: spec.name,
      surface,
      observation,
      ...(Array.isArray(expectation.expect) &&
          expectation.expect.length > 1
        ? { accepted: expectation.expect }
        : {}),
      mismatches: checkObservation(expectation, observation),
    });
  }
  const position = new Map(
    corpus.cases.map((spec, index) => [spec.name, index]),
  );
  rows.sort((a, b) => position.get(a.name)! - position.get(b.name)!);
  const failures = rows.filter((row) => row.mismatches.length > 0);
  if (failures.length > 0) {
    throw new Error(
      `${engine} ${surface}: ${failures.length} conformance rows differ from tests/fixtures/conformance/expected.json:\n${
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
