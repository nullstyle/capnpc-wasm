import { createWorkerCompiler } from "../../dist/typescript/mod.js";

const generate = document.querySelector("#generate");
const cancel = document.querySelector("#cancel");
const status = document.querySelector("#status");
const output = document.querySelector("#output");
let controller;

async function bytes(name) {
  const response = await fetch(
    new URL(`../../dist/wasm/${name}.wasm`, import.meta.url),
  );
  if (!response.ok) {
    throw new Error(`Cannot load ${name}: HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

try {
  const [compilerWasm, rust] = await Promise.all([
    bytes("capnp"),
    bytes("capnpc-rust"),
  ]);
  const compiler = await createWorkerCompiler(
    new URL("../../dist/typescript/worker.js", import.meta.url),
    { compiler: compilerWasm, generators: { rust } },
  );
  addEventListener("pagehide", () => compiler.dispose(), { once: true });
  generate.disabled = false;
  status.textContent = "Ready. Compilation runs locally in your browser.";
  cancel.onclick = () => controller?.abort();
  generate.onclick = async () => {
    controller = new AbortController();
    generate.disabled = true;
    cancel.disabled = false;
    status.textContent = "Compiling…";
    output.textContent = "";
    try {
      const result = await compiler.compile({
        files: { "person.capnp": document.querySelector("#schema").value },
        entrypoints: ["person.capnp"],
        generators: ["rust"],
      }, { signal: controller.signal });
      output.textContent = new TextDecoder().decode(
        result.outputs.rust["person_capnp.rs"],
      );
      status.textContent = "Generated person_capnp.rs";
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
