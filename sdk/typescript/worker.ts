import { createEngine, type Engine } from "./engine.ts";
import { JobControl } from "./interrupt.ts";
import {
  encodeError,
  postReply,
  type WireCompileJob,
  type WorkerReply,
  type WorkerRequest,
} from "./protocol.ts";

let engine: Engine | undefined;
// The client's cancellation cell; see InitMessage.interrupt.
let cell: Int32Array | undefined;
const scope = self as unknown as {
  onmessage: (event: MessageEvent<WorkerRequest>) => void;
  postMessage: (data: WorkerReply, transfer?: Transferable[]) => void;
};

/**
 * The client validated the job and transferred private copies; stage them by
 * mount without copying the bytes again. Keys are prefixed, so guest-chosen
 * names such as "__proto__" stay ordinary entries.
 */
function stage(job: WireCompileJob): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = Object.create(null);
  for (const [path, bytes] of Object.entries(job.files)) {
    files[`src/${path}`] = bytes;
  }
  for (const [path, bytes] of Object.entries(job.includeFiles)) {
    files[`include/${path}`] = bytes;
  }
  return files;
}

/**
 * The job's own deadline, measured from receipt, and its cancellation token:
 * the exchange id as the Int32 the client stores (never 0; see
 * worker-client.ts). A guest past either stops at its next check.
 */
function control(id: number, timeoutMs: number): JobControl {
  return new JobControl({
    deadline: performance.now() + timeoutMs,
    cell,
    token: id | 0,
  });
}

/** Result buffers are fresh private copies, so they can move without copying. */
function transferable(result: unknown): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  const collect = (value: unknown) => {
    if (
      value instanceof Uint8Array && value.buffer instanceof ArrayBuffer &&
      !value.buffer.resizable && value.buffer.byteLength > 0
    ) buffers.add(value.buffer);
  };
  const outcome = result as {
    request?: unknown;
    outputs?: Record<string, Record<string, unknown>>;
  };
  collect(outcome?.request);
  for (const files of Object.values(outcome?.outputs ?? {})) {
    for (const bytes of Object.values(files)) collect(bytes);
  }
  return [...buffers];
}

scope.onmessage = async ({ data }) => {
  let reply: WorkerReply;
  try {
    let result: unknown;
    if (data.kind === "init") {
      engine = await createEngine(data.modules, data.options);
      cell = data.interrupt ? new Int32Array(data.interrupt) : undefined;
    } else if (data.kind === "compile" && engine) {
      const job = data.request;
      result = await engine.compileStaged({
        files: stage(job),
        entrypoints: job.entrypoints,
        importPaths: job.importPaths,
        sourcePrefix: job.sourcePrefix,
        generators: job.generators,
      }, control(data.id, data.timeoutMs));
    } else if (data.kind === "generate" && engine) {
      result = await engine.generateStaged(
        data.request.request,
        data.request.generators,
        control(data.id, data.timeoutMs),
      );
    } else throw new Error("worker is not initialized or message is invalid");
    reply = { id: data.id, result };
  } catch (cause) {
    // Ordinary job failures, and jobs stopped at their deadline or through
    // the cell, are structured replies; the worker stays usable because
    // every job runs in fresh guest instances.
    reply = { id: data.id, error: encodeError(cause) };
  }
  postReply(scope, reply, () => transferable(reply.result));
};
