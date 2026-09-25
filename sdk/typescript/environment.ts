/**
 * Engine and host-runtime checks shared by both compiler factories. Failing
 * early here turns opaque engine parse errors and hosts without a usable
 * Worker into actionable errors before any module is compiled.
 */

/**
 * The one Deno release whose `Worker.terminate()` stopped a running guest,
 * which worker execution required before guests were instrumented with
 * interruption checks.
 * @deprecated Worker execution no longer depends on the Deno release: every
 * guest stops itself at its deadline or when its job is cancelled. Nothing
 * checks this value; it will be removed.
 */
export const supportedDenoWorkerVersion = "2.6.8";

// A minimal module using the standardized exception-handling instructions:
// (module (tag $e)
//   (func (block $h (result exnref) (try_table (catch_all_ref $h)) (return))
//     (drop)))
// Assembled with the pinned wasm-tools and stripped of custom sections.
// deno-fmt-ignore
const exceptionProbe = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic, version
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type section: () -> ()
  0x03, 0x02, 0x01, 0x00, // function section
  0x0d, 0x03, 0x01, 0x00, 0x00, // tag section
  0x0a, 0x0f, 0x01, 0x0d, 0x00, // code section, one body
  0x02, 0x69, // block (result exnref)
  0x1f, 0x40, 0x01, 0x03, 0x00, 0x0b, // try_table (catch_all_ref 0) end
  0x0f, 0x0b, 0x1a, 0x0b, // return end drop end
]);

/**
 * Whether this engine validates the standardized Wasm exception-handling
 * instructions (`try_table`, `exnref`) that the C++ compiler modules use.
 * Approximate first releases: Chrome 137, Firefox 131, Safari 18.4, Deno 2.3.
 */
export function supportsWasmExceptions(): boolean {
  try {
    return WebAssembly.validate(exceptionProbe);
  } catch {
    return false;
  }
}

export function requireWasmExceptions(): void {
  if (!supportsWasmExceptions()) {
    throw new TypeError(
      "this JavaScript engine does not validate standardized WebAssembly exception handling (exnref), which the compiler modules require; update the browser or runtime (approximately Chrome 137, Firefox 131, Safari 18.4, or Deno 2.3 and newer)",
    );
  }
}

export type WorkerRuntime =
  | { kind: "deno"; version: string }
  | { kind: "browser" }
  | { kind: "bun" }
  | { kind: "node" }
  | { kind: "unknown" };

/** Classify the host from its globals; injectable for tests. */
export function detectWorkerRuntime(
  globals: Record<string, unknown> = globalThis as unknown as Record<
    string,
    unknown
  >,
): WorkerRuntime {
  const deno = globals.Deno as { version?: { deno?: unknown } } | undefined;
  if (typeof deno?.version?.deno === "string") {
    return { kind: "deno", version: deno.version.deno };
  }
  if (globals.Bun !== undefined) return { kind: "bun" };
  const process = globals.process as
    | { versions?: { bun?: unknown; node?: unknown } }
    | undefined;
  if (typeof process?.versions?.bun === "string") return { kind: "bun" };
  if (typeof process?.versions?.node === "string") return { kind: "node" };
  // Window and worker scopes expose different globals; both are browsers
  // once Deno, Bun and Node have been excluded above.
  const browserScope = globals.document !== undefined ||
    globals.WorkerGlobalScope !== undefined;
  if (
    typeof globals.Worker === "function" &&
    typeof globals.navigator === "object" && globals.navigator !== null &&
    browserScope
  ) {
    return { kind: "browser" };
  }
  return { kind: "unknown" };
}

const directAdvice =
  "use createCompiler, whose jobs run on the calling thread with the same in-guest deadline";

/**
 * Admit worker execution where a module Worker runs the SDK's worker script:
 * browsers, Deno and Bun. Cancellation does not depend on the host's
 * `terminate()`: every guest stops itself at its deadline or, where a
 * SharedArrayBuffer reaches the worker, when its job is cancelled.
 */
export function checkWorkerRuntime(
  globals?: Record<string, unknown>,
): { runtime: WorkerRuntime } {
  const runtime = detectWorkerRuntime(globals);
  switch (runtime.kind) {
    case "deno":
    case "browser":
    case "bun":
      return { runtime };
    case "node":
      throw new Error(
        `Node.js has no Web Worker, so createWorkerCompiler is unavailable there; ${directAdvice}`,
      );
    default:
      throw new Error(
        `worker compilation is supported in browsers, Deno and Bun only; ${directAdvice}`,
      );
  }
}

/**
 * Whether createWorkerCompiler would be admitted on this host: browsers, Deno
 * and Bun. Applications use it to choose between worker execution and
 * createCompiler without rehearsing the rejection.
 */
export function isBoundedWorkerSupported(
  globals?: Record<string, unknown>,
): boolean {
  try {
    checkWorkerRuntime(globals);
    return true;
  } catch {
    return false;
  }
}
