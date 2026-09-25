import {
  copyFiles,
  resolveLimits,
  validateCompile,
  validateGenerate,
} from "./limits.ts";
import { checkWorkerRuntime, requireWasmExceptions } from "./environment.ts";
import {
  checkTimeout,
  defaultTimeoutMs,
  jobOptions,
  settleGraceMs,
  timeoutError,
} from "./interrupt.ts";
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
  JobOptions,
  Language,
  Modules,
} from "./types.ts";

export { supportedDenoWorkerVersion } from "./environment.ts";
// Shared with the direct compiler since both modes accept it; kept here too
// for importers of this module.
export type { JobOptions } from "./types.ts";

export interface WorkerCompilerOptions extends CompilerOptions {
  /** Aborts worker start-up: the worker is terminated and the factory rejects. */
  signal?: AbortSignal;
  /** Milliseconds allowed for the worker to load and compile every module. Defaults to 30000. */
  initTimeoutMs?: number;
}

export interface WorkerCompiler {
  /**
   * One active job per client. Cancellation stops the job's guest inside the
   * worker, which then serves the next job unless it had to be terminated;
   * see createWorkerCompiler.
   */
  compile(
    request: CompileRequest,
    options?: JobOptions,
  ): Promise<CompileResult>;
  generate(
    request: GenerationRequest,
    options?: JobOptions,
  ): Promise<GenerationResult>;
  /** Stop any running guest, terminate the worker, and reject pending work. */
  dispose(): void;
  /** The same as dispose(), for `using` on engines that provide Symbol.dispose. */
  [Symbol.dispose](): void;
}

function disposedError(): Error {
  return new Error("worker compiler is disposed");
}

/**
 * Resolve once, at creation, so restarts never re-resolve a relative URL
 * against a document base that moved. Relative strings resolve the way a
 * plain `new Worker(string)` would: against `document.baseURI` (which honours
 * `<base href>`), else the location. Injectable for tests.
 */
export function resolveWorkerURL(
  workerURL: string | URL,
  globals: {
    document?: { baseURI?: string };
    location?: { href?: string };
  } = globalThis as unknown as { document?: { baseURI?: string } },
): URL {
  if (workerURL instanceof URL) return new URL(workerURL.href);
  if (typeof workerURL !== "string") {
    throw new TypeError("worker URL must be a string or URL");
  }
  const base = globals.document?.baseURI ?? globals.location?.href;
  try {
    return new URL(workerURL, base);
  } catch (cause) {
    throw new TypeError(
      `worker URL must be absolute when no document location exists: ${workerURL}`,
      { cause },
    );
  }
}

/**
 * Fresh job copies can be moved to the worker instead of cloned again. A
 * buffer may appear once in a transfer list, and empty buffers gain nothing.
 */
function transferable(files: Record<string, Uint8Array>[]): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  for (const record of files) {
    for (const bytes of Object.values(record)) {
      if (bytes.buffer instanceof ArrayBuffer && bytes.buffer.byteLength > 0) {
        buffers.add(bytes.buffer);
      }
    }
  }
  return [...buffers];
}

/**
 * Whether a SharedArrayBuffer can reach a worker: in Deno and Bun always, in
 * browsers only on cross-origin isolated pages.
 */
function sharedCells(): boolean {
  if (typeof SharedArrayBuffer !== "function") return false;
  try {
    structuredClone(new SharedArrayBuffer(4));
    return true;
  } catch {
    return false;
  }
}

/** One worker, its cancellation cell, and a cancelled job still unwinding. */
interface Session {
  readonly worker: Worker;
  readonly cell?: Int32Array;
  ready: boolean;
  /** Resolves once the cancelled job reported or the worker was stopped. */
  settling?: Promise<void>;
  settle?: () => void;
}

/**
 * Worker entrypoint must be the built worker.js, served locally or as a blob.
 *
 * Cancellation (a timeout, an abort, or dispose) rejects the job at once and
 * stops its guest from inside: where a SharedArrayBuffer can reach the worker,
 * the client stores the job's id in a shared cell, and the guest traps at its
 * next interruption check; a timeout also trips the deadline the worker
 * enforces itself. Unless it is terminated, the worker then serves the next
 * job, which first waits for the cancelled one to report. The worker is
 * terminated and replaced only as a fallback: when a cancelled job does not
 * report within a second, when an abort cannot reach the guest (no
 * SharedArrayBuffer; the guest still stops at its own deadline where
 * terminate() does not stop it), when start-up is cancelled, when the worker
 * itself fails (`error` or `messageerror` events, or `postMessage` throwing),
 * and on dispose.
 * Ordinary rejections (`TypeError` for bad input, `CompileError` for guest
 * failures, including traps and limits) keep the worker, because every job
 * runs fresh guest instances and filesystems.
 */
export async function createWorkerCompiler(
  workerURL: string | URL,
  modules: Modules,
  options: WorkerCompilerOptions = {},
): Promise<WorkerCompiler> {
  checkWorkerRuntime();
  requireWasmExceptions();
  const url = resolveWorkerURL(workerURL);
  const limits = resolveLimits(options);
  const supplied = new Set<Language>(
    inspectModules(modules, limits.memoryPages),
  );
  const { signal: initSignal, initTimeoutMs = defaultTimeoutMs } = options;
  checkTimeout(initTimeoutMs, "initTimeoutMs");
  // Keep private copies of the validated fields only, for starting a
  // replacement worker: caller ownership stays intact, shared storage is not
  // retained, and unrelated properties on the caller's object are ignored.
  const snapshot: Modules = {
    compiler: new Uint8Array(modules.compiler),
    generators: {},
  };
  for (const language of supplied) {
    snapshot.generators[language] = new Uint8Array(
      modules.generators[language]!,
    );
  }
  const shared = sharedCells();
  let session: Session | undefined;
  let disposed = false;
  let busy = false;
  // Rejects the one pending operation: an exchange, or a wait for a
  // cancelled job to settle.
  let cancel: ((reason: unknown) => void) | undefined;
  let sequence = 0;

  /** Exchange ids double as cancellation tokens, so never 0 as an Int32. */
  function nextId(): number {
    do sequence++; while ((sequence | 0) === 0);
    return sequence;
  }

  function open(): Session {
    return session ??= {
      worker: new Worker(url, { type: "module" }),
      cell: shared ? new Int32Array(new SharedArrayBuffer(4)) : undefined,
      ready: false,
    };
  }

  /** Terminate a session's worker; the next job starts a fresh one. */
  function stop(current: Session): void {
    current.worker.terminate();
    current.ready = false;
    if (session === current) session = undefined;
    current.settle?.();
  }

  function exchange(
    message: WorkerMessage,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    transfer: Transferable[] = [],
  ): Promise<unknown> {
    if (disposed) return Promise.reject(disposedError());
    if (signal?.aborted) return Promise.reject(signal.reason);
    const current = open();
    const { worker } = current;
    const id = nextId();
    return new Promise((resolve, reject) => {
      // "running" until the caller's promise settles; "stopping" while a
      // cancelled job unwinds in the worker; "closed" once nothing is pending.
      // Every callback checks it: timers, abort events and replies can arrive
      // after the exchange ended (Deno 2.6.8 even runs a timer cleared by an
      // event handled in the same turn), and must then do nothing.
      let state: "running" | "stopping" | "closed" = "running";
      let grace: ReturnType<typeof setTimeout> | undefined;
      let unwound: (() => void) | undefined;
      // Stop listening to the caller.
      const release = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (cancel === interruptCaller) cancel = undefined;
      };
      // Stop listening to the worker too, and end a cancelled job's wait.
      const close = () => {
        state = "closed";
        release();
        clearTimeout(grace);
        worker.removeEventListener("message", receive);
        worker.removeEventListener("error", fail);
        worker.removeEventListener("messageerror", fail);
        if (current.settle === settleThis) {
          current.settling = current.settle = undefined;
        }
        unwound?.();
      };
      const settleThis = () => {
        if (state === "stopping") close();
      };
      // The worker failed, or nothing else can stop it: terminate and reject.
      const terminate = (reason: unknown) => {
        if (state === "closed") return;
        const running = state === "running";
        close();
        stop(current);
        if (running) reject(reason);
      };
      const interrupt = (reason: unknown, timedOut: boolean) => {
        if (state !== "running") return;
        // Start-up runs no guest, and without a cell only the job's own
        // deadline reaches a guest that blocks its worker.
        if (message.kind === "init" || (!current.cell && !timedOut)) {
          terminate(reason);
          return;
        }
        state = "stopping";
        release();
        reject(reason);
        if (current.cell) {
          Atomics.store(current.cell, 0, id);
          Atomics.notify(current.cell, 0);
        }
        current.settling = new Promise<void>((resolve) => unwound = resolve);
        current.settle = settleThis;
        grace = setTimeout(() => {
          if (state === "stopping") terminate(undefined);
        }, settleGraceMs);
      };
      const interruptCaller = (reason: unknown) => interrupt(reason, false);
      const abort = () => interrupt(signal!.reason, false);
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
        if (state === "stopping") {
          // The cancelled job stopped; its worker is free for the next job.
          if (current.cell) Atomics.store(current.cell, 0, 0);
          close();
          return;
        }
        if (state !== "running") return;
        close();
        // A structured error answers the job; the worker stays ready. Nothing
        // after close() may throw, or the job would never settle.
        if (reply.error === undefined) resolve(reply.result);
        else {
          let error: Error;
          try {
            error = decodeError(reply.error);
          } catch (cause) {
            error = new Error("worker reply could not be decoded", { cause });
          }
          reject(error);
        }
      };
      const timer = setTimeout(
        () => interrupt(timeoutError(), true),
        timeoutMs,
      );
      cancel = interruptCaller;
      signal?.addEventListener("abort", abort, { once: true });
      worker.addEventListener("message", receive);
      worker.addEventListener("error", fail);
      worker.addEventListener("messageerror", fail);
      try {
        worker.postMessage({ ...message, id, timeoutMs }, transfer);
      } catch (cause) {
        terminate(cause);
      }
    });
  }

  /** Wait until a cancelled job has reported, within the next job's bounds. */
  async function settled(
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<void> {
    const pending = session?.settling;
    if (!pending) return;
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (cancel === finish) cancel = undefined;
        if (error !== undefined) reject(error);
        else resolve();
      };
      const abort = () => finish(signal!.reason);
      const timer = setTimeout(
        () => finish(timeoutError()),
        Math.max(0, deadline - performance.now()),
      );
      cancel = finish;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      pending.then(() => finish());
    });
  }

  async function runJob(
    kind: "compile" | "generate",
    request: CompileRequest | GenerationRequest,
    options: JobOptions | undefined,
  ): Promise<unknown> {
    if (disposed) throw disposedError();
    if (busy) throw new Error("worker compiler already has an active job");
    const { signal, timeoutMs } = jobOptions(options);
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
      transfer = transferable([{ request: bytes }]);
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
      await settled(signal, deadline);
      if (disposed) throw disposedError();
      if (!session?.ready) {
        await initialize(signal, Math.max(0, deadline - performance.now()));
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw timeoutError();
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
    const current = open();
    try {
      await exchange(
        {
          kind: "init",
          modules: snapshot,
          options: { limits },
          interrupt: current.cell?.buffer as SharedArrayBuffer | undefined,
        },
        signal,
        timeoutMs,
      );
    } catch (cause) {
      stop(current);
      throw cause;
    }
    current.ready = true;
  }

  function dispose() {
    disposed = true;
    cancel?.(disposedError());
    if (session) stop(session);
  }

  if (initSignal?.aborted) throw initSignal.reason;
  await initialize(initSignal, initTimeoutMs);
  const client = {
    async compile(request: CompileRequest, options?: JobOptions) {
      return await runJob("compile", request, options) as CompileResult;
    },
    async generate(request: GenerationRequest, options?: JobOptions) {
      return await runJob("generate", request, options) as GenerationResult;
    },
    dispose,
  } as WorkerCompiler;
  // Engines without Symbol.dispose have no `using` either; the interface
  // still declares the member so the client is assignable to Disposable.
  if (typeof Symbol.dispose === "symbol") {
    Object.defineProperty(client, Symbol.dispose, {
      value: dispose,
      enumerable: false,
    });
  }
  return client;
}
