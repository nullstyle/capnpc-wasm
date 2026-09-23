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
  type CompileRequest,
  type CompilerOptions,
  type Diagnostic,
  type GenerationRequest,
  type Language,
  type Modules,
} from "./types.ts";

export interface InitMessage {
  kind: "init";
  id: number;
  modules: Modules;
  options: CompilerOptions;
}

export interface CompileMessage {
  kind: "compile";
  id: number;
  request: CompileRequest;
}

export interface GenerateMessage {
  kind: "generate";
  id: number;
  request: GenerationRequest;
}

export type WorkerRequest = InitMessage | CompileMessage | GenerateMessage;

/** A request before the client assigns its exchange id. */
export type WorkerMessage = WorkerRequest extends infer Request
  ? Request extends WorkerRequest ? Omit<Request, "id"> : never
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

function named(error: Error, name: string): Error {
  if (name !== "Error" && name !== error.name) {
    Object.defineProperty(error, "name", {
      value: name,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  return error;
}

function restore(summary: ErrorSummary | undefined): Error | undefined {
  if (!summary) return undefined;
  const nested = restore(summary.cause);
  return named(
    new Error(summary.message, nested ? { cause: nested } : undefined),
    summary.name,
  );
}

/** Rebuild the error class direct execution would have thrown. */
export function decodeError(error: WireError): Error {
  const cause = restore(error.cause);
  const options = cause ? { cause } : undefined;
  switch (error.kind) {
    case "compile":
      return new CompileError(
        error.message,
        error.stage,
        error.diagnostics,
        error.exitCode,
        options,
      );
    case "type":
      return new TypeError(error.message, options);
    case "range":
      return new RangeError(error.message, options);
    default:
      return named(new Error(error.message, options), error.name);
  }
}
