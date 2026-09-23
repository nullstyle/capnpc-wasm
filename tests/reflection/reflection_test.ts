import { assert, assertBytesEqual } from "../lib/assert.ts";
import { copyTree } from "../lib/fs.ts";
import {
  clangxx,
  nativeCompile,
  stageStandardIncludes,
} from "../lib/oracle.ts";
import { root, wasmBin, zigCacheDir } from "../lib/paths.ts";
import { decodeText, mustSucceed, run } from "../lib/process.ts";
import { testSuite } from "../lib/workdir.ts";

const suite = testSuite("reflection-");
const runtime = `${root}/build/src/capnp-zig/src/lib_core.zig`;

suite.test("Zig reflection: binary schema fidelity and native/WASI dynamic interoperability", async (t) => {
  const work = await suite.workDir();
  const source = `${work}/src`;
  await copyTree(`${root}/tests/fixtures/features/workspace`, source);
  await Deno.copyFile(
    `${root}/tests/reflection/reflection.capnp`,
    `${source}/reflection.capnp`,
  );
  await stageStandardIncludes(`${work}/include`);
  const request = await nativeCompile([
    `${source}/values.capnp`,
    `${source}/nested/brands.capnp`,
    `${source}/shared/common.capnp`,
    `${source}/reflection.capnp`,
  ], { include: [`${work}/include`], srcPrefix: source, cwd: work });
  await Deno.writeFile(`${work}/request.bin`, request);
  const output = `${work}/generated`;
  await Deno.mkdir(output);
  await mustSucceed(
    ["wasmtime", "run", "--dir", `${output}::/`, `${wasmBin}/capnpc-zig.wasm`],
    { cwd: work, stdin: request, label: "Wasm Zig generator" },
  );
  await Deno.writeTextFile(
    `${output}/root.zig`,
    'pub const values = @import("values.zig");\npub const brands = @import("nested/brands.zig");\npub const scalars = @import("reflection.zig");\n',
  );
  const oracle = `${work}/oracle`;
  await mustSucceed(
    clangxx([
      "-std=c++23",
      `-I${root}/ref/capnproto/c++/src`,
      `${root}/tests/reflection/oracle.c++`,
      `${root}/build/native/lib/libcapnp.a`,
      `${root}/build/native/lib/libkj.a`,
      "-pthread",
      "-o",
      oracle,
    ]),
    { label: "C++ reflection oracle build" },
  );
  for (const target of ["native", "wasi"]) {
    await t.step(
      `${target}: registry ownership and schema validation`,
      async () => {
        const executable = `${work}/registry-tests-${target}${
          target === "wasi" ? ".wasm" : ""
        }`;
        await mustSucceed([
          "zig",
          "test",
          "--test-filter",
          "registry",
          "--cache-dir",
          zigCacheDir,
          ...(target === "wasi"
            ? ["-target", "wasm32-wasi", "--test-no-exec"]
            : []),
          "--dep",
          "capnpc-zig",
          `-Mroot=${root}/tests/reflection/registry_test.zig`,
          `-Mcapnpc-zig=${runtime}`,
          `-femit-bin=${executable}`,
        ], { label: `${target} registry tests build` });
        if (target === "wasi") {
          await mustSucceed(["wasmtime", "run", executable], {
            cwd: work,
            label: "wasi registry tests",
          });
        }
      },
    );
    for (
      const name of [
        "generated_builder_test",
        "builder_evolution_test",
        "double_far_validation_test",
        "dynamic_failure_test",
        "copy_limits_test",
        "fuzz_test",
      ]
    ) {
      await t.step(`${target}: ${name}`, async () => {
        const executable = `${work}/${name}-${target}${
          target === "wasi" ? ".wasm" : ""
        }`;
        const generatedDependency = name === "generated_builder_test" ||
          name === "fuzz_test";
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
          ...(generatedDependency ? ["--dep", "generated"] : []),
          `-Mroot=${root}/tests/reflection/${name}.zig`,
          ...(generatedDependency
            ? ["--dep", "capnpc-zig", `-Mgenerated=${output}/root.zig`]
            : []),
          `-Mcapnpc-zig=${runtime}`,
          `-femit-bin=${executable}`,
        ], { label: `${target} ${name} build` });
        if (target === "wasi") {
          await mustSucceed(["wasmtime", "run", executable], {
            cwd: work,
            label: `wasi ${name}`,
          });
        }
      });
    }
    await t.step(
      `${target}: schema lookup, defaults, dynamic mutation and C++ decode`,
      async () => {
        const directory = `${work}/${target}`;
        await Deno.mkdir(directory);
        const executable = `${directory}/consumer${
          target === "wasi" ? ".wasm" : ""
        }`;
        await mustSucceed([
          "zig",
          "build-exe",
          "--cache-dir",
          zigCacheDir,
          ...(target === "wasi" ? ["-target", "wasm32-wasi"] : []),
          "--dep",
          "capnpc-zig",
          "--dep",
          "generated",
          `-Mroot=${root}/tests/reflection/consumer.zig`,
          "--dep",
          "capnpc-zig",
          `-Mgenerated=${output}/root.zig`,
          `-Mcapnpc-zig=${runtime}`,
          `-femit-bin=${executable}`,
        ], { label: `${target} consumer build` });
        await mustSucceed(
          target === "native" ? [executable, "."] : [
            "wasmtime",
            "run",
            "--dir",
            `${directory}::/`,
            executable,
            ".",
          ],
          { cwd: directory, label: `${target} consumer` },
        );
        const oracleArgs = [
          `${work}/request.bin`,
          `${directory}/schema.bin`,
          `${directory}/values.bin`,
          `${directory}/scalars.bin`,
          directory,
        ];
        await mustSucceed([oracle, ...oracleArgs], {
          label: `${target} C++ oracle`,
        });
        const ablation = await run([
          oracle,
          ...oracleArgs,
          "--inject-mismatch",
        ]);
        assert(
          ablation.code === 2,
          `C++ mutation mismatch gate did not reject: ${
            decodeText(ablation.stderr)
          }`,
        );
      },
    );
  }
  await t.step(
    "native and WASI descriptors and messages match byte for byte",
    async () => {
      const evolutionCases = [
        "inline-small",
        "far-inline",
        "inline-init",
        "inline-extra-data",
        "inline-extra-pointers",
        "inline-zero-width",
        "byte",
        "u16",
        "u32",
        "u64",
        "pointer",
        "void",
        "empty-inline",
        "empty-byte",
        "copy-large",
        "boolean-rejected",
        "empty-boolean-rejected",
        "nested",
      ];
      for (
        const filename of [
          "schema.bin",
          "values.bin",
          "builder-values.bin",
          "scalars.bin",
          ...evolutionCases.map((name) => `evolution-${name}.bin`),
        ]
      ) {
        assertBytesEqual(
          await Deno.readFile(`${work}/native/${filename}`),
          await Deno.readFile(`${work}/wasi/${filename}`),
          filename,
        );
      }
      for await (const entry of Deno.readDir(`${work}/native`)) {
        if (entry.isFile && entry.name.startsWith("mutation-")) {
          assertBytesEqual(
            await Deno.readFile(`${work}/native/${entry.name}`),
            await Deno.readFile(`${work}/wasi/${entry.name}`),
            entry.name,
          );
        }
      }
    },
  );
});
