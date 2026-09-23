import { createCompiler } from "./mod.ts";
import {
  encodeError,
  type WorkerReply,
  type WorkerRequest,
} from "./protocol.ts";
import type { Compiler } from "./types.ts";

let compiler: Compiler | undefined;
const scope = self as unknown as {
  onmessage: (event: MessageEvent<WorkerRequest>) => void;
  postMessage: (data: WorkerReply, transfer?: Transferable[]) => void;
};

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
      compiler = await createCompiler(data.modules, data.options);
    } else if (data.kind === "compile" && compiler) {
      result = await compiler.compile(data.request);
    } else if (data.kind === "generate" && compiler) {
      result = await compiler.generate(data.request);
    } else throw new Error("worker is not initialized or message is invalid");
    reply = { id: data.id, result };
  } catch (cause) {
    // Ordinary job failures are structured replies; the worker stays usable
    // because every job already runs in fresh guest instances.
    reply = { id: data.id, error: encodeError(cause) };
  }
  scope.postMessage(reply, transferable(reply.result));
};
