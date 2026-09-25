import {
  createCompiler,
  createWorkerCompiler,
  defaultLimits,
  supportedDenoWorkerVersion,
} from "@nullstyle/capnpc-wasm";
import { compilerPathFixture } from "./compiler-path-fixture.ts";

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
const worker = Deno.version.deno === supportedDenoWorkerVersion
  ? await createWorkerCompiler(new URL("typescript/worker.js", root), modules)
  : undefined;
if (!worker) {
  try {
    await createWorkerCompiler(new URL("typescript/worker.js", root), modules);
    throw new Error("unsupported worker unexpectedly succeeded");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes(`use Deno ${supportedDenoWorkerVersion}`)
    ) throw error;
  }
}
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
  const threaded = worker ? await worker.compile(request) : undefined;
  for (const language of languages) {
    if (!result.outputs[language]?.[expected[language]]?.length) {
      throw new Error(`missing ${language} package output`);
    }
    for (const [name, bytes] of Object.entries(result.outputs[language]!)) {
      const hash = await digest(bytes);
      if (
        await digest(generated.outputs[language]![name]) !== hash ||
        (threaded && await digest(threaded.outputs[language]![name]) !== hash)
      ) throw new Error(`package replay/worker mismatch: ${language}/${name}`);
      hashes[`${language}/${name}`] = hash;
    }
  }
} finally {
  worker?.dispose();
}
// The shared compiler-path fixture in both import root orders; the package
// gate compares these digests with the Go consumer's go-paths.json.
const paths: Record<string, string> = {};
for (
  const [key, importPaths] of [
    ["paths/request", compilerPathFixture.importPaths],
    ["paths/request-reversed", [...compilerPathFixture.importPaths].reverse()],
  ] as const
) {
  paths[key] = await digest(
    (await compiler.compile({ ...compilerPathFixture, importPaths })).request,
  );
}
await Deno.writeTextFile(
  new URL("./deno-paths.json", import.meta.url),
  JSON.stringify(paths),
);
await Deno.writeTextFile(
  new URL("./deno-result.json", import.meta.url),
  JSON.stringify(hashes),
);
console.log(
  `External npm-layout Deno direct/replay and ${
    worker ? "worker execution" : "worker runtime rejection"
  } passed`,
);
