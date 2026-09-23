import {
  copyFiles,
  resolveLimits,
  validateCompile,
  validateGenerate,
} from "./limits.ts";
import { checkWorkerRuntime, requireWasmExceptions } from "./environment.ts";
import { inspectModules } from "./wasm.ts";
import {
  decodeError,
  type WorkerMessage,
  type WorkerReply,
} from "./protocol.ts";
import type {
  CompileRequest,
  CompileResult,
  CompilerOptions,
  GenerationRequest,
  GenerationResult,
  Language,
  Modules,
} from "./types.ts";

export { supportedDenoWorkerVersion } from "./environment.ts";

export interface JobOptions {
  /** Aborting terminates the worker and rejects with `signal.reason`. */
  signal?: AbortSignal;
  /**
   * Milliseconds until the job rejects with a `TimeoutError` DOMException and
   * its worker is terminated. Defaults to 30000 and includes any restart wait.
   */
  timeoutMs?: number;
}

export interface WorkerCompilerOptions extends CompilerOptions {
  /** Aborts worker start-up: the worker is terminated and the factory rejects. */
  signal?: AbortSignal;
  /** Milliseconds allowed for the worker to load and compile every module. Defaults to 30000. */
  initTimeoutMs?: number;
}

export interface WorkerCompiler {
  /** One active job per client. Cancellation terminates its worker. */
  compile(
    request: CompileRequest,
    options?: JobOptions,
  ): Promise<CompileResult>;
  generate(
    request: GenerationRequest,
    options?: JobOptions,
  ): Promise<GenerationResult>;
  /** Terminate the worker and reject any pending operation. */
  dispose(): void;
  /** `using` support where the engine provides Symbol.dispose. */
  [Symbol.dispose]?(): void;
}

const defaultTimeoutMs = 30_000;

function disposedError(): Error {
  return new Error("worker compiler is disposed");
}

function timeoutError(): DOMException {
  return new DOMException("compilation timed out", "TimeoutError");
}

function checkTimeout(timeoutMs: number, name: string): void {
  if (
    !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  ) {
    throw new TypeError(`${name} must be positive and at most 2147483647`);
  }
}

/** Resolve once, so restarts never re-resolve a relative URL against a moved document base. */
function resolveWorkerURL(workerURL: string | URL): URL {
  if (workerURL instanceof URL) return new URL(workerURL.href);
  if (typeof workerURL !== "string") {
    throw new TypeError("worker URL must be a string or URL");
  }
  const base = (globalThis as { location?: { href?: string } }).location?.href;
  try {
    return new URL(workerURL, base);
  } catch (cause) {
    throw new TypeError(
      `worker URL must be absolute when no document location exists: ${workerURL}`,
      { cause },
    );
  }
}

/** Fresh job copies can be moved to the worker instead of cloned again. */
function transferable(files: Record<string, Uint8Array>[]): Transferable[] {
  const buffers: Transferable[] = [];
  for (const record of files) {
    for (const bytes of Object.values(record)) {
      if (bytes.buffer instanceof ArrayBuffer) buffers.push(bytes.buffer);
    }
  }
  return buffers;
}

/**
 * Worker entrypoint must be the built worker.js, served locally or as a blob.
 *
 * Restart policy: the worker is terminated and replaced only when a job times
 * out or is aborted, when the client is disposed, when the worker itself fails
 * (`error`/`messageerror` events, or `postMessage` throwing). Ordinary
 * rejections (`TypeError` for bad input, `CompileError` for guest failures,
 * including traps and limits) keep the worker, because every job already runs
 * fresh guest instances and filesystems.
 */
export async function createWorkerCompiler(
  workerURL: string | URL,
  modules: Modules,
  options: WorkerCompilerOptions = {},
): Promise<WorkerCompiler> {
  // Admit only runtimes where terminate() is verified to stop a running guest.
  const { terminationGraceMs } = checkWorkerRuntime();
  requireWasmExceptions();
  const url = resolveWorkerURL(workerURL);
  const limits = resolveLimits(options);
  const supplied = new Set<Language>(
    inspectModules(modules, limits.memoryPages),
  );
  const { signal: initSignal, initTimeoutMs = defaultTimeoutMs } = options;
  checkTimeout(initTimeoutMs, "initTimeoutMs");
  // Keep private copies for restarting after cancellation; caller ownership stays intact.
  const snapshot = structuredClone(modules);
  // Structured cloning preserves SharedArrayBuffer storage. Copy every byte
  // view explicitly so queued jobs and restarted workers own their snapshots.
  if (snapshot.compiler instanceof Uint8Array) {
    snapshot.compiler = new Uint8Array(snapshot.compiler);
  }
  for (const [language, module] of Object.entries(snapshot.generators)) {
    if (module instanceof Uint8Array) {
      snapshot.generators[language as Language] = new Uint8Array(module);
    }
  }
  let worker: Worker | undefined;
  let ready = false;
  let disposed = false;
  let busy = false;
  let cancel: ((reason: unknown) => void) | undefined;
  let sequence = 0;
  let restartAfter = 0;

  function stop() {
    if (worker) {
      worker.terminate();
      restartAfter = performance.now() + terminationGraceMs;
    }
    worker = undefined;
    ready = false;
  }

  async function waitForTermination(
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<void> {
    const waitMs = restartAfter - performance.now();
    if (waitMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        cancel = undefined;
        if (error !== undefined) reject(error);
        else resolve();
      };
      const abort = () => finish(signal!.reason);
      const remaining = deadline - performance.now();
      const timer = setTimeout(() => {
        if (remaining < waitMs) finish(timeoutError());
        else finish();
      }, Math.max(0, Math.min(waitMs, remaining)));
      cancel = (reason) => finish(reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  function exchange(
    message: WorkerMessage,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    transfer: Transferable[] = [],
  ): Promise<unknown> {
    if (disposed) return Promise.reject(disposedError());
    if (signal?.aborted) return Promise.reject(signal.reason);
    worker ??= new Worker(url, { type: "module" });
    const active = worker;
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        active.removeEventListener("message", receive);
        active.removeEventListener("error", fail);
        active.removeEventListener("messageerror", fail);
        cancel = undefined;
      };
      // The worker may still be running a guest, or is no longer trustworthy:
      // terminate it and reject.
      const terminate = (reason: unknown) => {
        cleanup();
        stop();
        reject(reason);
      };
      const abort = () => terminate(signal!.reason);
      const fail = (event: Event) => {
        event.preventDefault();
        terminate(
          new Error(
            event.type === "messageerror"
              ? "worker message could not be deserialized"
              : event instanceof ErrorEvent && event.message
              ? event.message
              : `worker script failed to load: ${url.href}`,
          ),
        );
      };
      const receive = (event: MessageEvent<WorkerReply>) => {
        const reply = event.data;
        if (typeof reply !== "object" || reply === null || reply.id !== id) {
          return;
        }
        cleanup();
        // A structured error answers the job; the worker stays ready.
        if (reply.error) reject(decodeError(reply.error));
        else resolve(reply.result);
      };
      const timer = setTimeout(() => terminate(timeoutError()), timeoutMs);
      cancel = terminate;
      signal?.addEventListener("abort", abort, { once: true });
      active.addEventListener("message", receive);
      active.addEventListener("error", fail);
      active.addEventListener("messageerror", fail);
      try {
        active.postMessage({ ...message, id }, transfer);
      } catch (cause) {
        terminate(cause);
      }
    });
  }

  async function runJob(
    kind: "compile" | "generate",
    request: CompileRequest | GenerationRequest,
    { signal, timeoutMs = defaultTimeoutMs }: JobOptions = {},
  ): Promise<unknown> {
    if (disposed) throw disposedError();
    if (busy) throw new Error("worker compiler already has an active job");
    checkTimeout(timeoutMs, "timeoutMs");
    if (signal?.aborted) throw signal.reason;
    // Every synchronous check runs here, on the calling thread, with the same
    // code as the direct compiler: invalid inputs reject before any copy or
    // post, with the same TypeError the direct path throws.
    let message: WorkerMessage;
    let transfer: Transferable[];
    if (kind === "generate") {
      const job = validateGenerate(
        request as GenerationRequest,
        limits,
        supplied,
      );
      const bytes = new Uint8Array(job.request);
      message = {
        kind,
        request: { request: bytes, generators: job.generators },
      };
      transfer = [bytes.buffer as ArrayBuffer];
    } else {
      const job = validateCompile(request as CompileRequest, limits, supplied);
      const files = copyFiles(job.sources);
      const includeFiles = copyFiles(job.annotations);
      message = {
        kind,
        request: {
          files,
          includeFiles,
          importPaths: job.importPaths,
          sourcePrefix: job.sourcePrefix,
          entrypoints: job.entrypoints,
          generators: job.generators,
        },
      };
      transfer = transferable([files, includeFiles]);
    }
    busy = true;
    const deadline = performance.now() + timeoutMs;
    try {
      if (!ready) {
        await waitForTermination(signal, deadline);
        if (disposed) throw disposedError();
        await initialize(signal, Math.max(0, deadline - performance.now()));
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        stop();
        throw timeoutError();
      }
      return await exchange(message, signal, remaining, transfer);
    } finally {
      busy = false;
    }
  }

  /** A worker whose modules failed to load is useless: terminate it too. */
  async function initialize(
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<void> {
    try {
      await exchange(
        { kind: "init", modules: snapshot, options: { limits } },
        signal,
        timeoutMs,
      );
    } catch (cause) {
      stop();
      throw cause;
    }
    ready = true;
  }

  function dispose() {
    disposed = true;
    cancel?.(disposedError());
    stop();
  }

  if (initSignal?.aborted) throw initSignal.reason;
  await initialize(initSignal, initTimeoutMs);
  const client: WorkerCompiler = {
    async compile(request, options) {
      return await runJob("compile", request, options) as CompileResult;
    },
    async generate(request, options) {
      return await runJob("generate", request, options) as GenerationResult;
    },
    dispose,
  };
  if (typeof Symbol.dispose === "symbol") {
    Object.defineProperty(client, Symbol.dispose, {
      value: dispose,
      enumerable: false,
    });
  }
  return client;
}
