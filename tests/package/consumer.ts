import {
  createCompiler,
  createWorkerCompiler,
  defaultLimits,
} from "@nullstyle/capnpc-wasm";

const root = new URL("./node_modules/@nullstyle/capnpc-wasm/", import.meta.url);
const read = (path: string) => Deno.readFile(new URL(path, root));
const languages = ["cpp", "rust", "go", "zig"] as const;
const modules = {
  compiler: await read("wasm/capnp.wasm"),
  generators: {
    cpp: await read("wasm/capnpc-c++.wasm"),
    rust: await read("wasm/capnpc-rust.wasm"),
    go: await read("wasm/capnpc-go.wasm"),
    zig: await read("wasm/capnpc-zig.wasm"),
  },
};
const request = {
  files: {
    "candidate.capnp": await Deno.readFile(
      new URL("./schema.capnp", import.meta.url),
    ),
  },
  includeFiles: { "go.capnp": await read("include/go.capnp") },
  entrypoints: ["candidate.capnp"],
  generators: languages,
};
const compiler = await createCompiler(modules, {
  limits: { memoryPages: defaultLimits.memoryPages },
});
const result = await compiler.compile(request);
const worker = await createWorkerCompiler(
  new URL("typescript/worker.js", root),
  modules,
);
const expected: Record<string, string> = {
  cpp: "candidate.capnp.h",
  rust: "candidate_capnp.rs",
  go: "candidate.capnp.go",
  zig: "candidate.zig",
};
async function digest(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
  ].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
const hashes: Record<string, string> = {
  request: await digest(result.request),
};
try {
  const generated = await compiler.generate({
    request: result.request,
    generators: languages,
  });
  const threaded = await worker.compile(request);
  for (const language of languages) {
    if (!result.outputs[language]?.[expected[language]]?.length) {
      throw new Error(`missing ${language} package output`);
    }
    for (const [name, bytes] of Object.entries(result.outputs[language]!)) {
      const hash = await digest(bytes);
      if (
        await digest(generated.outputs[language]![name]) !== hash ||
        await digest(threaded.outputs[language]![name]) !== hash
      ) throw new Error(`package replay/worker mismatch: ${language}/${name}`);
      hashes[`${language}/${name}`] = hash;
    }
  }
} finally {
  worker.dispose();
}
await Deno.writeTextFile(
  new URL("./deno-result.json", import.meta.url),
  JSON.stringify(hashes),
);
console.log(
  "External npm-layout Deno direct, replay, and worker consumers passed",
);
