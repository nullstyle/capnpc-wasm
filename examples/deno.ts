// Run from the root: mise exec -- deno run --allow-read=dist examples/deno.ts
// @deno-types="../dist/typescript/mod.d.ts"
import { createCompiler } from "../dist/typescript/mod.js";

const compiler = await createCompiler({
  compiler: await Deno.readFile("dist/wasm/capnp.wasm"),
  generators: { rust: await Deno.readFile("dist/wasm/capnpc-rust.wasm") },
});
// Loading is complete. Generation itself needs no Deno permissions.
await Deno.permissions.revoke({ name: "read" });
const result = await compiler.compile({
  files: {
    "person.capnp": "@0xece4bf9c1f867623; struct Person { name @0 :Text; }",
  },
  entrypoints: ["person.capnp"],
  generators: ["rust"],
});
console.log(new TextDecoder().decode(result.outputs.rust!["person_capnp.rs"]));
