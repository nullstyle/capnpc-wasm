import { createWorkerCompiler } from "../../dist/typescript/mod.js";

const generate = document.querySelector("#generate");
const cancel = document.querySelector("#cancel");
const status = document.querySelector("#status");
const output = document.querySelector("#output");
const files = document.querySelector("#files");
const download = document.querySelector("#download");
const generated = new Map();
let controller;

async function bytes(path) {
  const response = await fetch(new URL(`../../dist/${path}`, import.meta.url));
  if (!response.ok) {
    throw new Error(`Cannot load ${path}: HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function showFile() {
  output.textContent = new TextDecoder().decode(generated.get(files.value));
}
files.onchange = showFile;
download.onclick = () => {
  const data = generated.get(files.value);
  if (!data) return;
  const url = URL.createObjectURL(new Blob([data], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = files.value.split("/").pop();
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

try {
  const [compilerWasm, cpp, rust, go, cxxAnnotations, goAnnotations] =
    await Promise.all([
      bytes("wasm/capnp.wasm"),
      bytes("wasm/capnpc-c++.wasm"),
      bytes("wasm/capnpc-rust.wasm"),
      bytes("wasm/capnpc-go.wasm"),
      bytes("include/capnp/c++.capnp"),
      bytes("include/go.capnp"),
    ]);
  const compiler = await createWorkerCompiler(
    new URL("../../dist/typescript/worker.js", import.meta.url),
    { compiler: compilerWasm, generators: { cpp, rust, go } },
  );
  let cachedSchema;
  let cachedRequest;
  addEventListener("pagehide", () => compiler.dispose(), { once: true });
  generate.disabled = false;
  status.textContent = "Ready. Compilation runs locally in your browser.";
  cancel.onclick = () => controller?.abort();
  generate.onclick = async () => {
    controller = new AbortController();
    const options = { signal: controller.signal };
    const schema = document.querySelector("#schema").value;
    const language = document.querySelector("#language").value;
    const targets = language === "all" ? ["cpp", "rust", "go"] : [language];
    generate.disabled = true;
    cancel.disabled = false;
    files.disabled = download.disabled = true;
    files.replaceChildren();
    generated.clear();
    output.textContent = "";
    try {
      if (cachedSchema !== schema || !cachedRequest) {
        status.textContent = "Compiling…";
        const result = await compiler.compile({
          files: { "person.capnp": schema },
          includeFiles: {
            "capnp/c++.capnp": cxxAnnotations,
            "go.capnp": goAnnotations,
          },
          entrypoints: ["person.capnp"],
          generators: [],
        }, options);
        cachedSchema = schema;
        cachedRequest = result.request;
      }
      status.textContent = "Generating…";
      const result = await compiler.generate({
        request: cachedRequest,
        generators: targets,
      }, options);
      for (const [target, entries] of Object.entries(result.outputs)) {
        for (
          const [path, data] of Object.entries(entries).sort(([a], [b]) =>
            a.localeCompare(b)
          )
        ) {
          const name = `${target}/${path}`;
          generated.set(name, data);
          const option = document.createElement("option");
          option.value = option.textContent = name;
          files.append(option);
        }
      }
      files.disabled = download.disabled = generated.size === 0;
      if (generated.size) showFile();
      status.textContent = `Generated ${generated.size} files.`;
    } catch (error) {
      status.textContent = error.name === "AbortError"
        ? "Cancelled."
        : error.message;
      output.textContent = error.diagnostics?.map((item) =>
        item.stderr
      ).join("\n") ?? "";
    } finally {
      generate.disabled = false;
      cancel.disabled = true;
    }
  };
} catch (error) {
  status.textContent = error.message;
}
