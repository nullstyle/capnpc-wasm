import {
  copyFiles,
  resolveLimits,
  validateGeneration,
  validateWorkspace,
} from "./limits.ts";
import {
  CompileError,
  type CompileRequest,
  type CompileResult,
  type CompilerOptions,
  type GenerationRequest,
  type GenerationResult,
  type Modules,
} from "./types.ts";

export interface JobOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
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
}

/** Worker entrypoint must be the built worker.js, served locally or as a blob. */
export async function createWorkerCompiler(
  workerURL: string | URL,
  modules: Modules,
  options: CompilerOptions = {},
): Promise<WorkerCompiler> {
  const limits = resolveLimits(options);
  // Keep private copies for restarting after cancellation; caller ownership stays intact.
  const snapshot = structuredClone(modules);
  // Structured cloning preserves SharedArrayBuffer storage. Copy every byte
  // view explicitly so queued jobs and restarted workers own their snapshots.
  if (snapshot.compiler instanceof Uint8Array) {
    snapshot.compiler = new Uint8Array(snapshot.compiler);
  }
  for (const [language, module] of Object.entries(snapshot.generators)) {
    if (module instanceof Uint8Array) {
      snapshot.generators[language] = new Uint8Array(module);
    }
  }
  let worker: Worker | undefined;
  let ready = false;
  let disposed = false;
  let busy = false;
  let cancel: ((reason: unknown) => void) | undefined;
  let sequence = 0;

  function stop() {
    worker?.terminate();
    worker = undefined;
    ready = false;
  }

  function exchange(
    message: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    if (disposed) {
      return Promise.reject(new Error("worker compiler is disposed"));
    }
    if (signal?.aborted) return Promise.reject(signal.reason);
    worker ??= new Worker(workerURL, { type: "module" });
    const active = worker;
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown, value?: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        active.removeEventListener("message", receive);
        active.removeEventListener("error", fail);
        active.removeEventListener("messageerror", fail);
        cancel = undefined;
        if (error !== undefined) {
          stop();
          reject(error);
        } else resolve(value);
      };
      const abort = () => finish(signal!.reason);
      const fail = (event: Event) => {
        event.preventDefault();
        finish(
          new Error(
            event instanceof ErrorEvent
              ? event.message
              : "worker message failed",
          ),
        );
      };
      const receive = (event: MessageEvent) => {
        if (event.data.id !== id) return;
        const error = event.data.error;
        if (error) {
          const cause = error.name === "CompileError"
            ? new CompileError(
              error.message,
              error.stage,
              error.diagnostics,
              error.exitCode,
            )
            : new Error(error.message);
          if (!(cause instanceof CompileError)) cause.name = error.name;
          finish(cause);
        } else finish(undefined, event.data.result);
      };
      const timer = setTimeout(
        () => finish(new DOMException("compilation timed out", "TimeoutError")),
        timeoutMs,
      );
      cancel = (reason) => finish(reason);
      signal?.addEventListener("abort", abort, { once: true });
      active.addEventListener("message", receive);
      active.addEventListener("error", fail);
      active.addEventListener("messageerror", fail);
      try {
        active.postMessage({ ...message, id });
      } catch (cause) {
        finish(cause);
      }
    });
  }

  async function runJob(
    kind: "compile" | "generate",
    request: CompileRequest | GenerationRequest,
    { signal, timeoutMs = 30_000 }: JobOptions = {},
  ): Promise<unknown> {
    if (disposed) throw new Error("worker compiler is disposed");
    if (busy) throw new Error("worker compiler already has an active job");
    if (
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      timeoutMs > 2_147_483_647
    ) {
      throw new TypeError(
        "timeoutMs must be positive and at most 2147483647",
      );
    }
    if (signal?.aborted) throw signal.reason;
    // Validate before copying or posting to the worker; reject oversized inputs
    // on the calling thread, including after timeout/restart.
    let job: CompileRequest | GenerationRequest;
    if (kind === "generate") {
      const generation = request as GenerationRequest;
      const bytes = validateGeneration(generation, limits);
      job = {
        request: new Uint8Array(bytes),
        generators: [...generation.generators],
      };
    } else {
      const compilation = request as CompileRequest;
      const [sources, annotations] = validateWorkspace(compilation, limits);
      job = {
        files: copyFiles(sources),
        includeFiles: copyFiles(annotations),
        entrypoints: [...compilation.entrypoints],
        generators: [...compilation.generators],
      };
    }
    busy = true;
    const deadline = performance.now() + timeoutMs;
    try {
      if (!ready) {
        await exchange(
          { kind: "init", modules: snapshot, options: { limits } },
          signal,
          timeoutMs,
        );
        ready = true;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        stop();
        throw new DOMException("compilation timed out", "TimeoutError");
      }
      return await exchange(
        { kind, request: job },
        signal,
        remaining,
      );
    } finally {
      busy = false;
    }
  }

  await exchange(
    { kind: "init", modules: snapshot, options: { limits } },
    undefined,
    30_000,
  );
  ready = true;
  return {
    async compile(request, options) {
      return await runJob("compile", request, options) as CompileResult;
    },
    async generate(request, options) {
      return await runJob("generate", request, options) as GenerationResult;
    },
    dispose() {
      disposed = true;
      cancel?.(new Error("worker compiler is disposed"));
      stop();
    },
  };
}
