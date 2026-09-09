const destination = Deno.args[0] ?? "dist";
if (
  !/^dist(?:\/[a-zA-Z0-9_.-]+)*$/.test(destination) ||
  destination.split("/").some((part) => part === "..")
) throw new Error("asset destination must stay under dist/");
async function toolPath(args: string[]): Promise<string> {
  const result = await new Deno.Command(args[0], {
    args: args.slice(1),
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}
for (const directory of ["wasm", "include", "licenses"]) {
  await Deno.remove(`${destination}/${directory}`, { recursive: true }).catch(
    (error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    },
  );
}
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
  await copy(`build/wasm/bin/${name}.wasm`, `${destination}/wasm/${name}.wasm`);
}
for (const name of schemas) {
  await copy(
    `ref/capnproto/c++/src/capnp/${name}`,
    `${destination}/include/capnp/${name}`,
  );
}
await copy("ref/go-capnp/std/go.capnp", `${destination}/include/go.capnp`);
for (
  const [name, license] of [
    ["capnproto", "LICENSE"],
    ["capnproto-rust", "LICENSE"],
    ["go-capnp", "LICENSE"],
    ["capnp-zig", "LICENSE"],
    ["browser_wasi_shim", "LICENSE-MIT"],
    ["browser_wasi_shim", "LICENSE-APACHE"],
    ["wazero", "LICENSE"],
    ["wazero", "NOTICE"],
    ["wasi-sdk", "LICENSE"],
  ]
) {
  await copy(
    `ref/${name}/${license}`,
    `${destination}/licenses/${name}-${license}`,
  );
}
const go = await toolPath(["go", "env", "GOROOT"]);
const rust = await toolPath(["rustc", "--print", "sysroot"]);
const zig = await toolPath(["mise", "where", "zig"]);
await copy(`${go}/LICENSE`, `${destination}/licenses/go-LICENSE`);
await copy(
  `${rust}/share/doc/rust/COPYRIGHT-library.html`,
  `${destination}/licenses/rust-COPYRIGHT-library.html`,
);
for (
  const path of [
    "LICENSE",
    "lib/libc/wasi/LICENSE",
    "lib/libc/wasi/LICENSE-MIT",
    "lib/libc/wasi/LICENSE-APACHE",
    "lib/libc/wasi/LICENSE-APACHE-LLVM",
    "lib/libc/wasi/libc-bottom-half/cloudlibc/LICENSE",
    "lib/libcxx/LICENSE.TXT",
    "lib/libcxxabi/LICENSE.TXT",
    "lib/libunwind/LICENSE.TXT",
  ]
) {
  await copy(
    `${zig}/${path}`,
    `${destination}/licenses/zig-${path.replaceAll("/", "-")}`,
  );
}
console.log(
  `Staged SDK modules, standard schemas, and upstream/runtime licenses in ${destination}/`,
);
