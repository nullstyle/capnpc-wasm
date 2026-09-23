/**
 * Engine and host-runtime checks shared by both compiler factories. Failing
 * early here turns opaque engine parse errors and unverified worker
 * termination into actionable TypeErrors before any module is compiled.
 */

/** Deno worker termination is verified only on this runtime revision. */
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
  "use createCompiler for direct execution without a hard deadline";

/**
 * Admit worker execution only where cancellation is verified to stop guest
 * CPU: browsers and the verified Deno release. Returns the restart grace the
 * client must wait after terminate() on that runtime.
 */
export function checkWorkerRuntime(
  globals?: Record<string, unknown>,
): { runtime: WorkerRuntime; terminationGraceMs: number } {
  const runtime = detectWorkerRuntime(globals);
  switch (runtime.kind) {
    case "deno":
      if (runtime.version !== supportedDenoWorkerVersion) {
        throw new Error(
          `Deno ${runtime.version} worker termination is not supported; use Deno ${supportedDenoWorkerVersion} for bounded worker compilation, or ${directAdvice}`,
        );
      }
      // Deno 2.6.8 requests forced isolate termination after a two-second
      // grace; keep restarts outside it so repeated cancellation cannot
      // accumulate still-running guests. Browsers get no wait here, although
      // terminate() is not immediate everywhere: Chromium stops a running
      // guest after about two seconds and WebKit never stops it (see the SDK
      // README); a later track addresses that.
      return { runtime, terminationGraceMs: 2100 };
    case "browser":
      return { runtime, terminationGraceMs: 0 };
    case "bun":
    case "node":
      throw new Error(
        `${
          runtime.kind === "bun" ? "Bun" : "Node.js"
        } worker termination is not verified to stop a running Wasm guest, so createWorkerCompiler is unavailable there; ${directAdvice}`,
      );
    default:
      throw new Error(
        `worker compilation is supported in browsers and on Deno ${supportedDenoWorkerVersion} only; ${directAdvice}`,
      );
  }
}

/**
 * Whether createWorkerCompiler would be admitted on this host: browsers and
 * the verified Deno release. Applications use it to choose between bounded
 * worker execution and createCompiler without rehearsing the rejection.
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
