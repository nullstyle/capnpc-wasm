import { createWorkerCompiler } from "../../sdk/typescript/mod.ts";

export const languages = { cpp: "C++", rust: "Rust", go: "Go", zig: "Zig" };
const commands = {
  cpp: "capnpc-c++",
  rust: "capnpc-rust",
  go: "capnpc-go",
  zig: "capnpc-zig",
};
const includePaths = [
  "go.capnp",
  "capnp/c++.capnp",
  "capnp/schema.capnp",
  "capnp/stream.capnp",
  "capnp/rpc.capnp",
  "capnp/rpc-twoparty.capnp",
  "capnp/persistent.capnp",
  "capnp/compat/json.capnp",
  "capnp/compat/byte-stream.capnp",
  "capnp/compat/http-over-capnp.capnp",
  "capnp/compat/json-rpc.capnp",
];

export function studioCompiler(assetBase) {
  const cache = new Map();
  let frontend;
  let generator;
  let generatorKey;
  let workerURL;
  let initialization;
  let disposed = false;

  async function asset(path, signal) {
    if (cache.has(path)) return cache.get(path);
    const response = await fetch(new URL(path, assetBase), { signal });
    if (!response.ok) {
      throw new Error(
        `Could not load ${path} (HTTP ${response.status}). Select Generate to retry.`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    cache.set(path, bytes);
    return bytes;
  }

  async function abortable(pending, signal) {
    let onAbort;
    try {
      return await Promise.race([
        pending,
        new Promise((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async function client(targets, signal) {
    const [compiler, worker, ...modules] = await Promise.all([
      asset("wasm/capnp.wasm", signal),
      asset("typescript/worker.js", signal),
      ...targets.map((target) =>
        asset(`wasm/${commands[target]}.wasm`, signal)
      ),
    ]);
    signal.throwIfAborted();
    // The SDK factory has a fixed initialization deadline, but no abort input.
    // Track that one pending factory even after cancellation so rapid retries
    // cannot accumulate workers. A cancelled factory never executes a command.
    while (initialization) {
      await abortable(initialization.catch(() => {}), signal);
      signal.throwIfAborted();
    }
    if (!workerURL) {
      workerURL = URL.createObjectURL(
        new Blob([worker], { type: "text/javascript" }),
      );
    }
    const pending = createWorkerCompiler(workerURL, {
      compiler,
      generators: Object.fromEntries(
        targets.map((target, i) => [target, modules[i]]),
      ),
    }, {
      limits: {
        workspaceBytes: 8 * 1024 * 1024,
        workspaceEntries: 512,
        outputBytes: 16 * 1024 * 1024,
      },
    }).then((value) => {
      if (signal.aborted || disposed) {
        value.dispose();
        throw signal.reason ?? new Error("Studio closed.");
      }
      return value;
    });
    // Initialization has its own SDK deadline. Cancellation releases the UI
    // immediately and disposes any late-created worker before it can be used.
    initialization = pending.finally(() => {
      initialization = undefined;
    });
    return await abortable(initialization, signal);
  }

  return {
    async compile(workspace, signal, status) {
      status("Loading compiler and standard schemas…");
      const includes = Object.fromEntries(
        await Promise.all(
          includePaths.map(async (
            path,
          ) => [path, await asset(`include/${path}`, signal)]),
        ),
      );
      if (!frontend) frontend = await client([], signal);
      signal.throwIfAborted();
      status("Compiling workspace…");
      return await frontend.compile(workspace(includes), { signal });
    },
    async generate(request, targets, signal, status) {
      const key = [...targets].sort().join(",");
      if (!generator || generatorKey !== key) {
        status(
          `Loading ${
            targets.map((target) => languages[target]).join(", ")
          } generator${targets.length > 1 ? "s" : ""}…`,
        );
        generator?.dispose();
        generator = undefined;
        generatorKey = undefined;
        generator = await client(targets, signal);
        generatorKey = key;
      }
      signal.throwIfAborted();
      status(
        `Generating ${targets.map((target) => languages[target]).join(", ")}…`,
      );
      return await generator.generate({ request, generators: targets }, {
        signal,
      });
    },
    dispose() {
      disposed = true;
      frontend?.dispose();
      generator?.dispose();
      if (workerURL) URL.revokeObjectURL(workerURL);
      cache.clear();
    },
  };
}
