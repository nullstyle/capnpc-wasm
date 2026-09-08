// The SDK never searches a native installation for modules or standard schemas.
// Keep this local bundle paired with the exact binaries tested by the suite.
const modules = [
  "capnp",
  "capnpc-c++",
  "capnpc-capnp",
  "capnpc-rust",
  "capnpc-go",
  "capnpc-zig",
];
const schemas = [
  "c++.capnp",
  "schema.capnp",
  "stream.capnp",
  "rpc.capnp",
  "rpc-twoparty.capnp",
  "persistent.capnp",
  "compat/json.capnp",
  "compat/byte-stream.capnp",
  "compat/http-over-capnp.capnp",
  "compat/json-rpc.capnp",
];

async function copy(source: string, target: string) {
  await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
    recursive: true,
  });
  await Deno.copyFile(source, target);
}

for (const name of modules) {
  await copy(`build/wasm/bin/${name}.wasm`, `dist/wasm/${name}.wasm`);
}
for (const name of schemas) {
  await copy(
    `ref/capnproto/c++/src/capnp/${name}`,
    `dist/include/capnp/${name}`,
  );
}
await copy("ref/go-capnp/std/go.capnp", "dist/include/go.capnp");
for (
  const [name, license] of [
    ["capnproto", "LICENSE"],
    ["capnproto-rust", "LICENSE"],
    ["go-capnp", "LICENSE"],
    ["capnp-zig", "LICENSE"],
    ["browser_wasi_shim", "LICENSE-MIT"],
    ["browser_wasi_shim", "LICENSE-APACHE"],
  ]
) {
  await copy(`ref/${name}/${license}`, `dist/licenses/${name}-${license}`);
}
console.log(
  "Staged SDK modules, standard schemas, and upstream licenses in dist/",
);
