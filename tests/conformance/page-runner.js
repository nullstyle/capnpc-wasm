// @ts-check
// Runs one corpus case on a TypeScript compiler surface and reports what
// happened as structured-cloneable summaries. Shared by the Deno runners
// (direct and worker) and the browser driver (direct, worker, and the Schema
// Studio adapter), so every TypeScript surface executes a case the same way
// and the classification in outcome.ts sees the same shape. This file is
// served to browser pages: no Deno, Node, or TypeScript syntax.

/**
 * @typedef {{ name: string, message: string }} CauseLink
 * @typedef {{
 *   name: string,
 *   message: string,
 *   isCompileError: boolean,
 *   isTypeError: boolean,
 *   stage?: string,
 *   exitCode?: number,
 *   diagnostics: { stage: string, stderrBytes: number }[],
 *   hasOutputs: boolean,
 *   chain: CauseLink[],
 * }} ErrorSummary
 * @typedef {{
 *   outputs: Record<string, number>,
 *   diagnostics: { stage: string, stderrBytes: number }[],
 *   requestBytes?: number,
 * }} ResultSummary
 * @typedef {{
 *   name: string,
 *   op: "compile" | "generate",
 *   entrypoints?: string[],
 *   importPaths?: string[],
 *   sourcePrefix?: string,
 *   generators: string[],
 *   compiler?: string,
 *   generatorGuests?: Record<string, string>,
 *   limits?: Record<string, number>,
 *   deadlineMs?: number,
 * }} CaseSpec
 * @typedef {{
 *   files: Record<string, Uint8Array>,
 *   includeFiles: Record<string, Uint8Array>,
 *   request?: Uint8Array,
 * }} CaseInputs
 * @typedef {{ compiler: Uint8Array, generators: Record<string, Uint8Array> }} Modules
 * @typedef {{
 *   create: (modules: Modules, options: { limits: Record<string, number> }, key: string) => Promise<any>,
 *   release: (compiler: any) => void,
 *   jobOptions: (spec: CaseSpec) => object | undefined,
 *   CompileError: Function,
 * }} SurfaceHost
 */

const encoder = new TextEncoder();

/** @param {{ stage: string, stderr: string }[] | undefined} diagnostics */
function summarizeDiagnostics(diagnostics) {
  return (diagnostics ?? []).map((entry) => ({
    stage: entry.stage,
    stderrBytes: encoder.encode(entry.stderr).length,
  }));
}

/**
 * @param {unknown} error
 * @param {Function} CompileError the SDK class of the surface that threw
 * @returns {ErrorSummary}
 */
export function summarizeError(error, CompileError) {
  const failure = /** @type {any} */ (error);
  const chain = [];
  let cause = failure?.cause;
  for (let depth = 0; cause instanceof Error && depth < 6; depth++) {
    chain.push({ name: cause.name, message: cause.message });
    cause = cause.cause;
  }
  return {
    name: String(failure?.name ?? "Error"),
    message: String(failure?.message ?? failure),
    isCompileError: error instanceof CompileError,
    isTypeError: error instanceof TypeError,
    stage: typeof failure?.stage === "string" ? failure.stage : undefined,
    exitCode: typeof failure?.exitCode === "number"
      ? failure.exitCode
      : undefined,
    diagnostics: summarizeDiagnostics(failure?.diagnostics),
    hasOutputs: error !== null && typeof error === "object" &&
      "outputs" in error,
    chain,
  };
}

/**
 * @param {any} result
 * @returns {ResultSummary}
 */
export function summarizeResult(result) {
  /** @type {Record<string, number>} */
  const outputs = {};
  for (const [language, files] of Object.entries(result.outputs ?? {})) {
    outputs[language] = Object.keys(files).length;
  }
  return {
    outputs,
    diagnostics: summarizeDiagnostics(result.diagnostics),
    requestBytes: result.request ? result.request.length : undefined,
  };
}

/**
 * The module set a case runs with: real modules, with the case's guests
 * replacing the compiler or a generator.
 *
 * @param {CaseSpec} spec
 * @param {Modules} modules
 * @param {Record<string, Uint8Array>} guests
 * @returns {Modules}
 */
export function caseModules(spec, modules, guests) {
  /** @param {string} name */
  const named = (name) => {
    const bytes = guests[name];
    if (!bytes) throw new Error(`${spec.name}: unknown guest ${name}`);
    return bytes;
  };
  /** @type {Record<string, Uint8Array>} */
  const generators = {};
  for (const language of spec.generators) {
    const guest = spec.generatorGuests?.[language];
    generators[language] = guest ? named(guest) : modules.generators[language];
  }
  return {
    compiler: spec.compiler ? named(spec.compiler) : modules.compiler,
    generators,
  };
}

/**
 * The job a case submits.
 *
 * @param {CaseSpec} spec
 * @param {CaseInputs} inputs
 */
export function caseJob(spec, inputs) {
  if (spec.op === "generate") {
    return { request: inputs.request, generators: spec.generators };
  }
  /** @type {Record<string, unknown>} */
  const job = {
    files: inputs.files,
    includeFiles: inputs.includeFiles,
    entrypoints: spec.entrypoints,
    generators: spec.generators,
  };
  if (spec.importPaths) job.importPaths = spec.importPaths;
  if (spec.sourcePrefix !== undefined) job.sourcePrefix = spec.sourcePrefix;
  return job;
}

/**
 * A host that reuses one client while consecutive cases share a module set and
 * limits, and disposes it when the configuration changes, so a surface
 * compiles its modules once per run of cases instead of once per case and
 * never holds more than one client (in a browser, one worker) at a time. Run
 * the cases in orderCases() order. A client a cancelled job terminated
 * restarts by itself on its next job.
 *
 * @param {{
 *   create: (modules: Modules, options: { limits: Record<string, number> }) => Promise<any>,
 *   jobOptions: (spec: CaseSpec) => object | undefined,
 *   CompileError: Function,
 * }} base
 * @returns {SurfaceHost & { disposeAll: () => void }}
 */
export function cachingHost(base) {
  /** @type {{ key: string, client: any } | undefined} */
  let current;
  const dispose = () => {
    if (typeof current?.client?.dispose === "function") {
      current.client.dispose();
    }
    current = undefined;
  };
  return {
    CompileError: base.CompileError,
    jobOptions: base.jobOptions,
    async create(modules, options, key) {
      if (current?.key === key) return current.client;
      dispose();
      const client = await base.create(modules, options);
      current = { key, client };
      return client;
    },
    release() {},
    disposeAll: dispose,
  };
}

/**
 * The cache key of a case's module set and limits.
 *
 * @param {CaseSpec} spec
 */
export function configurationKey(spec) {
  return JSON.stringify([
    spec.compiler ?? "",
    spec.generatorGuests ?? {},
    [...spec.generators].sort(),
    spec.limits ?? {},
  ]);
}

/**
 * The order every TypeScript surface runs the corpus in: cases grouped by
 * configuration (so cachingHost reuses clients), and cases with a deadline
 * last, because an engine whose terminate() does not stop Wasm (WebKit) keeps
 * each timed-out guest spinning until the browser closes. Outcomes do not
 * depend on the order.
 *
 * @template {CaseSpec} T
 * @param {T[]} cases
 * @returns {T[]}
 */
export function orderCases(cases) {
  return [...cases].sort((a, b) =>
    Number(Boolean(a.deadlineMs)) - Number(Boolean(b.deadlineMs)) ||
    (configurationKey(a) < configurationKey(b)
      ? -1
      : configurationKey(a) > configurationKey(b)
      ? 1
      : 0)
  );
}

/**
 * Run one case on a direct or worker compiler surface.
 *
 * @param {CaseSpec} spec
 * @param {CaseInputs} inputs
 * @param {SurfaceHost} host
 * @param {Modules} modules
 * @param {Record<string, Uint8Array>} guests
 * @returns {Promise<{ phase: "factory" | "job", summary: ErrorSummary | ResultSummary }>}
 */
export async function runCase(spec, inputs, host, modules, guests) {
  let compiler;
  try {
    compiler = await host.create(
      caseModules(spec, modules, guests),
      { limits: spec.limits ?? {} },
      configurationKey(spec),
    );
  } catch (error) {
    return {
      phase: "factory",
      summary: summarizeError(error, host.CompileError),
    };
  }
  try {
    const job = caseJob(spec, inputs);
    const options = host.jobOptions(spec);
    const result = spec.op === "compile"
      ? await compiler.compile(job, options)
      : await compiler.generate(job, options);
    return { phase: "job", summary: summarizeResult(result) };
  } catch (error) {
    return { phase: "job", summary: summarizeError(error, host.CompileError) };
  } finally {
    host.release(compiler);
  }
}

/**
 * Run one case through the Schema Studio adapter (examples/browser/compiler.js),
 * which compiles with the bundled standard includes and generates separately,
 * exactly as the app does. Custom guests and limits are not expressible here;
 * callers skip those cases.
 *
 * @param {CaseSpec} spec
 * @param {CaseInputs} inputs
 * @param {any} studio a studioCompiler() instance
 * @param {Function} CompileError
 * @returns {Promise<{ phase: "job", summary: ErrorSummary | ResultSummary }>}
 */
export async function runStudioCase(spec, inputs, studio, CompileError) {
  const signal = spec.deadlineMs
    ? AbortSignal.timeout(spec.deadlineMs)
    : new AbortController().signal;
  const status = () => {};
  try {
    let request = inputs.request;
    if (spec.op === "compile") {
      const compiled = await studio.compile(
        /** @param {Record<string, Uint8Array>} standard */
        (standard) => ({
          files: inputs.files,
          includeFiles: { ...standard, ...inputs.includeFiles },
          entrypoints: spec.entrypoints,
          generators: [],
        }),
        signal,
        status,
      );
      if (spec.generators.length === 0) {
        return { phase: "job", summary: summarizeResult(compiled) };
      }
      request = compiled.request;
    }
    const generated = await studio.generate(
      request,
      spec.generators,
      signal,
      status,
    );
    return { phase: "job", summary: summarizeResult(generated) };
  } catch (error) {
    return { phase: "job", summary: summarizeError(error, CompileError) };
  }
}
