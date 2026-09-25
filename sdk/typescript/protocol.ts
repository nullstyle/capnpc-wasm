/**
 * Messages exchanged between worker-client.ts (the calling thread) and
 * worker.ts (the guest thread). Errors cross the boundary with an explicit
 * discriminant so the client rebuilds the same classes that direct execution
 * throws; nothing routes on `name`, which engine errors such as
 * WebAssembly.CompileError share with the SDK's own CompileError.
 *
 * Every message carries the exchange id it answers. Later tracks extend these
 * types in place rather than adding a second protocol.
 */
import {
  CompileError,
  type CompilerOptions,
  type Diagnostic,
  type Language,
  type Modules,
} from "./types.ts";

export interface InitMessage {
  kind: "init";
  id: number;
  modules: Modules;
  options: CompilerOptions;
  /**
   * A cell shared with the client, when SharedArrayBuffer can cross to the
   * worker: the client cancels a running job by storing its id (as an Int32)
   * in element 0 and notifying, and the job's guest traps at its next check.
   */
  interrupt?: SharedArrayBuffer;
}

/**
 * A compile job after the client validated it and made private byte copies:
 * the worker trusts these records and stages them without copying again.
 */
export interface WireCompileJob {
  files: Record<string, Uint8Array>;
  includeFiles: Record<string, Uint8Array>;
  importPaths: string[];
  sourcePrefix: string;
  entrypoints: string[];
  generators: Language[];
}

export interface WireGenerateJob {
  /** A private copy of the caller's request bytes. */
  request: Uint8Array;
  generators: Language[];
}

export interface CompileMessage {
  kind: "compile";
  id: number;
  /** Milliseconds left of the job's deadline; the worker enforces it too. */
  timeoutMs: number;
  request: WireCompileJob;
}

export interface GenerateMessage {
  kind: "generate";
  id: number;
  timeoutMs: number;
  request: WireGenerateJob;
}

export type WorkerRequest = InitMessage | CompileMessage | GenerateMessage;

/** A request before the client assigns its exchange id and remaining time. */
export type WorkerMessage = WorkerRequest extends infer Request
  ? Request extends WorkerRequest ? Omit<Request, "id" | "timeoutMs">
  : never
  : never;

/** A bounded, structured-cloneable view of an error's cause chain. */
export interface ErrorSummary {
  name: string;
  message: string;
  cause?: ErrorSummary;
}

export type WireError =
  | {
    kind: "compile";
    message: string;
    stage: "compiler" | Language;
    diagnostics: Diagnostic[];
    exitCode?: number;
    cause?: ErrorSummary;
  }
  | { kind: "type"; message: string; cause?: ErrorSummary }
  | { kind: "range"; message: string; cause?: ErrorSummary }
  /** The job stopped at its deadline or through the shared cell. */
  | {
    kind: "cancel";
    name: "TimeoutError" | "AbortError";
    message: string;
    cause?: ErrorSummary;
  }
  | { kind: "error"; name: string; message: string; cause?: ErrorSummary };

export type WorkerReply =
  | { id: number; result: unknown; error?: undefined }
  | { id: number; error: WireError; result?: undefined };

const causeDepth = 4;

function summarize(cause: unknown, depth: number): ErrorSummary | undefined {
  if (cause === undefined || depth === 0) return undefined;
  if (cause instanceof Error) {
    const summary: ErrorSummary = { name: cause.name, message: cause.message };
    const nested = summarize(cause.cause, depth - 1);
    if (nested) summary.cause = nested;
    return summary;
  }
  return { name: "Error", message: String(cause) };
}

/** Serialize a thrown value without invoking String() on Error instances. */
export function encodeError(cause: unknown): WireError {
  if (cause instanceof CompileError) {
    return {
      kind: "compile",
      message: cause.message,
      stage: cause.stage,
      diagnostics: cause.diagnostics.map(({ stage, stderr }) => ({
        stage,
        stderr,
      })),
      exitCode: cause.exitCode,
      cause: summarize(cause.cause, causeDepth),
    };
  }
  if (
    cause instanceof DOMException &&
    (cause.name === "TimeoutError" || cause.name === "AbortError")
  ) return { kind: "cancel", name: cause.name, message: cause.message };
  if (cause instanceof TypeError) {
    return {
      kind: "type",
      message: cause.message,
      cause: summarize(cause.cause, causeDepth),
    };
  }
  if (cause instanceof RangeError) {
    return {
      kind: "range",
      message: cause.message,
      cause: summarize(cause.cause, causeDepth),
    };
  }
  if (cause instanceof Error) {
    return {
      kind: "error",
      name: cause.name,
      message: cause.message,
      cause: summarize(cause.cause, causeDepth),
    };
  }
  return { kind: "error", name: "Error", message: String(cause) };
}

function named(error: Error, name: unknown): Error {
  if (typeof name === "string" && name !== "Error" && name !== error.name) {
    Object.defineProperty(error, "name", {
      value: name,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  return error;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

// The sender already bounds its summary; bound decoding independently so a
// malformed, cyclic or very deep chain can never overflow the stack here.
const decodeDepth = 8;

function restore(summary: unknown, depth: number): Error | undefined {
  if (typeof summary !== "object" || summary === null || depth === 0) {
    return undefined;
  }
  const { name, message, cause } = summary as Partial<ErrorSummary>;
  const nested = restore(cause, depth - 1);
  return named(
    new Error(text(message), nested ? { cause: nested } : undefined),
    name,
  );
}

/**
 * Rebuild the error class direct execution would have thrown. Total: any
 * reply shape yields an Error, so the client always settles its job.
 */
export function decodeError(error: WireError): Error {
  try {
    if (typeof error !== "object" || error === null) {
      return new Error(`worker reported an error: ${text(error)}`);
    }
    const cause = restore(error.cause, decodeDepth);
    const options = cause ? { cause } : undefined;
    const message = text(error.message);
    switch (error.kind) {
      case "compile":
        return new CompileError(
          message,
          error.stage,
          Array.isArray(error.diagnostics) ? error.diagnostics : [],
          typeof error.exitCode === "number" ? error.exitCode : undefined,
          options,
        );
      case "type":
        return new TypeError(message, options);
      case "range":
        return new RangeError(message, options);
      case "cancel":
        return new DOMException(
          message,
          error.name === "AbortError" ? "AbortError" : "TimeoutError",
        );
      default:
        return named(
          new Error(message, options),
          (error as { name?: unknown }).name,
        );
    }
  } catch (cause) {
    return new Error("worker reply could not be decoded", { cause });
  }
}
