import { assertBytesEqual } from "./lib/assert.ts";
import { nativeCompile } from "./lib/oracle.ts";
import { nativeBin, root, wasmBin, zigCacheDir } from "./lib/paths.ts";
import { mustSucceed } from "./lib/process.ts";
import { testSuite } from "./lib/workdir.ts";

const suite = testSuite("generator-api-");

suite.test("Zig concrete generic APIs: native/WASI generation and executable views", async (t) => {
  const cases: { name: string; schema: string; consumer: string }[] = JSON
    .parse(
      await Deno.readTextFile(`${root}/tests/generator_api/cases.json`),
    );
  const work = await suite.workDir();
  const schemas = `${root}/tests/generator_api/schemas`;
  for (const profile of ["full", "compact"]) {
    for (const schema of new Set(cases.map((c) => c.schema))) {
      await t.step(
        `${profile}/${schema}: native and WASI source parity`,
        async () => {
          const request = await nativeCompile([`${schemas}/${schema}`], {
            srcPrefix: schemas,
          });
          const directory = `${work}/${profile}/${schema}`;
          const a = `${directory}/native`;
          const b = `${directory}/wasi`;
          await Deno.mkdir(a, { recursive: true });
          await Deno.mkdir(b, { recursive: true });
          await Deno.writeFile(`${directory}/request.bin`, request);
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
          const filename = schema.replace(/\.capnp$/, ".zig");
          assertBytesEqual(
            await Deno.readFile(`${b}/${filename}`),
            await Deno.readFile(`${a}/${filename}`),
            `${profile}/${schema}: generated sources`,
          );
          await Deno.copyFile(`${b}/${filename}`, `${directory}/generated.zig`);
        },
      );
    }
    for (const fixture of cases) {
      const directory = `${work}/${profile}/${fixture.schema}`;
      await Deno.copyFile(
        `${root}/tests/generator_api/consumers/${fixture.consumer}`,
        `${directory}/${fixture.consumer}`,
      );
      for (const target of ["native", "wasi"]) {
        await t.step(
          `${profile}/${fixture.name}/${target}: compile and use typed views`,
          async () => {
            const executable = `${directory}/${fixture.name}-${target}${
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
              `-Mcapnpc-zig=${root}/build/src/capnp-zig/src/lib_core.zig`,
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
