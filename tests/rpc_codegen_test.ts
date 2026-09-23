import { assert, assertTreesEqual } from "./lib/assert.ts";
import { readTree } from "./lib/fs.ts";
import { nativeCompile } from "./lib/oracle.ts";
import {
  nativeBin,
  root,
  wasmBin,
  zigCacheDir,
  zigRuntime,
} from "./lib/paths.ts";
import { mustSucceed } from "./lib/process.ts";
import { testSuite } from "./lib/workdir.ts";

const suite = testSuite("rpc-codegen-");

suite.test("Zig RPC APIs: native/WASI paths, inherited dispatch, and streaming", async (t) => {
  const cases = [
    {
      name: "pipeline",
      schemas: ["rpc_pipeline_paths.capnp"],
      consumer: "rpc_pipeline_consumer.zig",
    },
    {
      name: "inherited",
      schemas: ["rpc_inherited_paths.capnp", "rpc_inherited_external.capnp"],
      consumer: "rpc_inherited_consumer.zig",
    },
    {
      name: "streaming",
      schemas: ["streaming.capnp"],
      consumer: "rpc_stream_consumer.zig",
    },
    {
      name: "generic",
      schemas: ["generic_rpc.capnp", "generic_rpc_external.capnp"],
      consumer: "generic_rpc_consumer.zig",
    },
  ];
  const work = await suite.workDir();
  const schemas = `${root}/tests/rpc_codegen/schemas`;
  for (const profile of ["full", "compact"]) {
    for (const fixture of cases) {
      const directory = `${work}/${profile}/${fixture.name}`;
      const a = `${directory}/native`;
      const b = `${directory}/wasi`;
      const generated = await t.step(
        `${profile}/${fixture.name}: complete native/WASI source parity`,
        async () => {
          // The packaged schema tree must suffice for streaming. Imported
          // application schemas are explicitly requested so both modules are
          // generated and their complete outputs participate in parity checks.
          const request = await nativeCompile(
            fixture.schemas.map((schema) => `${schemas}/${schema}`),
            { include: [`${zigRuntime}/rpc`], srcPrefix: schemas },
          );
          await Deno.mkdir(a, { recursive: true });
          await Deno.mkdir(b, { recursive: true });
          await mustSucceed(
            [`${nativeBin}/capnpc-zig`, `--api-profile=${profile}`],
            { cwd: a, stdin: request, label: "native Zig generator" },
          );
          await mustSucceed([
            "wasmtime",
            "run",
            "--dir",
            `${b}::/`,
            `${wasmBin}/capnpc-zig.wasm`,
            `--api-profile=${profile}`,
          ], { stdin: request, label: "Wasm Zig generator" });
          const names = fixture.schemas.map((s) =>
            s.replace(/\.capnp$/, ".zig")
          )
            .sort();
          const expected = await readTree(a);
          assert(
            JSON.stringify([...expected.keys()]) === JSON.stringify(names),
            `${profile}/${fixture.name}: unexpected generated paths ${
              [...expected.keys()].join(", ")
            }`,
          );
          await assertTreesEqual(b, expected, `${profile}/${fixture.name}`);
          for (const path of names) {
            await Deno.copyFile(`${b}/${path}`, `${directory}/${path}`);
          }
          const primary = fixture.schemas[0].replace(/\.capnp$/, ".zig");
          await Deno.rename(
            `${directory}/${primary}`,
            `${directory}/generated.zig`,
          );
          await Deno.copyFile(
            `${root}/tests/rpc_codegen/consumers/${fixture.consumer}`,
            `${directory}/${fixture.consumer}`,
          );
        },
      );
      if (!generated) continue;
      for (const target of ["native", "wasi"]) {
        await t.step(
          `${profile}/${fixture.name}/${target}: execute generated RPC API`,
          async () => {
            const executable = `${directory}/consumer-${target}${
              target === "wasi" ? ".wasm" : ""
            }`;
            await mustSucceed([
              "zig",
              "test",
              "--cache-dir",
              zigCacheDir,
              ...(target === "wasi"
                ? ["-target", "wasm32-wasi", "--test-no-exec"]
                : []),
              "--dep",
              "capnpc-zig",
              `-Mroot=${directory}/${fixture.consumer}`,
              "--dep",
              "capnpc-zig",
              `-Mcapnpc-zig=${zigRuntime}/lib.zig`,
              `-femit-bin=${executable}`,
            ], { label: `${target} consumer build` });
            if (target === "wasi") {
              await mustSucceed(["wasmtime", "run", executable], {
                label: "wasi consumer",
              });
            }
          },
        );
      }
    }
  }
});
