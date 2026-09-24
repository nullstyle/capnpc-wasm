import {
  createWorkerCompiler,
  supportsWasmExceptions,
} from "../../sdk/typescript/mod.ts";
import { countNodes, limits } from "./workspace.js";

export { supportsWasmExceptions };

export const languages = { cpp: "C++", rust: "Rust", go: "Go", zig: "Zig" };
export const commands = {
  cpp: "capnpc-c++",
  rust: "capnpc-rust",
  go: "capnpc-go",
  zig: "capnpc-zig",
};
// build-studio.ts replaces this sentinel with a content hash of the staged
// site, so every asset URL changes with the build and a cached main.js can
// never run against another build's worker, modules, or includes.
export const assetVersion = "__STUDIO_ASSET_VERSION__";
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

const names = (targets) =>
  targets.map((target) => languages[target]).join(", ");

/**
 * One worker client compiles and generates. It is created with the compiler
 * and the generators requested so far, and replaced only when a job needs a
 * generator it does not hold: the new client owns the union, so switching
 * languages or returning to a single language never rebuilds a worker.
 */
export function studioCompiler(assetBase) {
  const cache = new Map();
  let includes;
  let client;
  let owned = new Set();
  let workerURL;
  let disposed = false;

  async function asset(path, signal) {
    if (cache.has(path)) return cache.get(path);
    const url = new URL(path, assetBase);
    url.searchParams.set("v", assetVersion);
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(
        `Could not load ${path} (HTTP ${response.status}). Select Generate to retry.`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    cache.set(path, bytes);
    return bytes;
  }

  async function standardIncludes(signal) {
    includes ??= Object.fromEntries(
      await Promise.all(
        includePaths.map(async (
          path,
        ) => [path, await asset(`include/${path}`, signal)]),
      ),
    );
    return includes;
  }

  // The SDK counts user files, the bundled includes, and every implied folder
  // against one budget. Grant Studio's user-facing budget plus the includes.
  function budget(standard) {
    const entries = Object.entries(standard);
    return {
      workspaceBytes: limits.bytes +
        entries.reduce((n, [, bytes]) => n + bytes.length, 0),
      workspaceEntries: limits.nodes +
        countNodes(entries.map(([path]) => path)),
      outputBytes: 16 * 1024 * 1024,
    };
  }

  async function ensureClient(targets, signal, status) {
    const missing = targets.filter((target) => !owned.has(target));
    if (client && !missing.length) return client;
    status(
      missing.length
        ? `Loading ${names(missing)} generator${missing.length > 1 ? "s" : ""}…`
        : "Loading compiler and standard schemas…",
    );
    const wanted = [...new Set([...owned, ...targets])];
    const [standard, compiler, worker, ...modules] = await Promise.all([
      standardIncludes(signal),
      asset("wasm/capnp.wasm", signal),
      workerURL ? undefined : asset("typescript/worker.js", signal),
      ...wanted.map((target) => asset(`wasm/${commands[target]}.wasm`, signal)),
    ]);
    signal.throwIfAborted();
    if (!workerURL) {
      // A blob URL keeps restarts after cancellation independent of the
      // network; the blob owns the only copy of the script.
      workerURL = URL.createObjectURL(
        new Blob([worker], { type: "text/javascript" }),
      );
      cache.delete("typescript/worker.js");
    }
    // Aborting the signal terminates the starting worker inside the SDK and
    // rejects here, so repeated cancellations cannot accumulate workers.
    const next = await createWorkerCompiler(workerURL, {
      compiler,
      generators: Object.fromEntries(
        wanted.map((target, i) => [target, modules[i]]),
      ),
    }, { signal, limits: budget(standard) });
    if (disposed) {
      next.dispose();
      throw new Error("Studio closed.");
    }
    client?.dispose();
    client = next;
    owned = new Set(wanted);
    // The client keeps private copies of its modules for restarts. Studio
    // keeps its own only while the client could still grow to another
    // language, which needs every module again; once all are loaded the
    // copies go, and each module's bytes are held once on this thread.
    if (owned.size === Object.keys(languages).length) {
      cache.delete("wasm/capnp.wasm");
      for (const target of owned) cache.delete(`wasm/${commands[target]}.wasm`);
    }
    return next;
  }

  return {
    /** Languages a worker already holds, for tests and diagnostics. */
    loaded: () => [...owned],
    async compile(workspace, targets, signal, status) {
      const standard = await standardIncludes(signal);
      const worker = await ensureClient(targets, signal, status);
      signal.throwIfAborted();
      status("Compiling workspace…");
      return await worker.compile(workspace(standard), { signal });
    },
    async generate(request, targets, signal, status) {
      const worker = await ensureClient(targets, signal, status);
      signal.throwIfAborted();
      status(`Generating ${names(targets)}…`);
      return await worker.generate({ request, generators: targets }, {
        signal,
      });
    },
    dispose() {
      disposed = true;
      client?.dispose();
      client = undefined;
      owned = new Set();
      if (workerURL) URL.revokeObjectURL(workerURL);
      cache.clear();
    },
  };
}
