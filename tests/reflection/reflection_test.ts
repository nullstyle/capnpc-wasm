const root = Deno.cwd();
const native = `${root}/build/native/bin`;
const decoder = new TextDecoder();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function command(args: string[], cwd: string, stdin?: Uint8Array) {
  const child = new Deno.Command(args[0], {
    args: args.slice(1),
    cwd,
    stdin: stdin ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(60_000),
  }).spawn();
  const output = child.output();
  if (stdin) {
    const writer = child.stdin.getWriter();
    try {
      await writer.write(stdin);
      await writer.close();
    } catch (error) {
      if (!(error instanceof Deno.errors.BrokenPipe)) throw error;
    } finally {
      writer.releaseLock();
    }
  }
  const result = await output;
  assert(
    result.success,
    `${args[0]} exited ${result.code}: ${decoder.decode(result.stderr)}`,
  );
  return result.stdout;
}

async function copyTree(source: string, destination: string) {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    if (entry.isDirectory) {
      await copyTree(`${source}/${entry.name}`, `${destination}/${entry.name}`);
    } else {
      assert(entry.isFile, `unexpected fixture ${entry.name}`);
      await Deno.copyFile(
        `${source}/${entry.name}`,
        `${destination}/${entry.name}`,
      );
    }
  }
}

function equalBytes(actual: Uint8Array, expected: Uint8Array, name: string) {
  assert(
    actual.length === expected.length &&
      actual.every((byte, index) => byte === expected[index]),
    `${name}: bytes differ`,
  );
}

Deno.test("Zig reflection: binary schema fidelity and native/WASI dynamic interoperability", async (t) => {
  await Deno.mkdir(`${root}/build/test`, { recursive: true });
  const work = await Deno.makeTempDir({
    dir: `${root}/build/test`,
    prefix: "reflection-",
  });
  const source = `${work}/src`;
  await copyTree(`${root}/tests/fixtures/features/workspace`, source);
  await Deno.copyFile(
    `${root}/tests/reflection/reflection.capnp`,
    `${source}/reflection.capnp`,
  );
  await Deno.mkdir(`${work}/include/capnp`, { recursive: true });
  await Deno.copyFile(
    `${root}/ref/capnproto/c++/src/capnp/c++.capnp`,
    `${work}/include/capnp/c++.capnp`,
  );
  await Deno.copyFile(
    `${root}/ref/go-capnp/std/go.capnp`,
    `${work}/include/go.capnp`,
  );
  const request = await command([
    `${native}/capnp`,
    "compile",
    "--no-standard-import",
    `-I${work}/include`,
    `--src-prefix=${source}`,
    "-o-",
    `${source}/values.capnp`,
    `${source}/nested/brands.capnp`,
    `${source}/shared/common.capnp`,
    `${source}/reflection.capnp`,
  ], work);
  await Deno.writeFile(`${work}/request.bin`, request);
  const output = `${work}/generated`;
  await Deno.mkdir(output);
  await command(
    [
      "wasmtime",
      "run",
      "--dir",
      `${output}::/`,
      `${root}/build/wasm/bin/capnpc-zig.wasm`,
    ],
    work,
    request,
  );
  await Deno.writeTextFile(
    `${output}/root.zig`,
    'pub const values = @import("values.zig");\npub const brands = @import("nested/brands.zig");\npub const scalars = @import("reflection.zig");\n',
  );
  const oracle = `${work}/oracle`;
  await command([
    "clang++",
    "-std=c++23",
    `-I${root}/ref/capnproto/c++/src`,
    `${root}/tests/reflection/oracle.c++`,
    `${root}/build/native/lib/libcapnp.a`,
    `${root}/build/native/lib/libkj.a`,
    "-pthread",
    "-o",
    oracle,
  ], root);
  for (const target of ["native", "wasi"]) {
    await t.step(
      `${target}: registry ownership and schema validation`,
      async () => {
        const executable = `${work}/registry-tests-${target}${
          target === "wasi" ? ".wasm" : ""
        }`;
        await command([
          "zig",
          "test",
          "--test-filter",
          "registry",
          "--cache-dir",
          `${root}/.cache/zig-local`,
          ...(target === "wasi"
            ? ["-target", "wasm32-wasi", "--test-no-exec"]
            : []),
          "--dep",
          "capnpc-zig",
          `-Mroot=${root}/tests/reflection/registry_test.zig`,
          `-Mcapnpc-zig=${root}/build/src/capnp-zig/src/lib_core.zig`,
          `-femit-bin=${executable}`,
        ], root);
        if (target === "wasi") {
          await command(["wasmtime", "run", executable], work);
        }
      },
    );
    for (
      const suite of [
        "generated_builder_test",
        "builder_evolution_test",
        "double_far_validation_test",
      ]
    ) {
      await t.step(`${target}: ${suite}`, async () => {
        const executable = `${work}/${suite}-${target}${
          target === "wasi" ? ".wasm" : ""
        }`;
        const generatedDependency = suite === "generated_builder_test";
        await command([
          "zig",
          "test",
          "--cache-dir",
          `${root}/.cache/zig-local`,
          ...(target === "wasi"
            ? ["-target", "wasm32-wasi", "--test-no-exec"]
            : []),
          "--dep",
          "capnpc-zig",
          ...(generatedDependency ? ["--dep", "generated"] : []),
          `-Mroot=${root}/tests/reflection/${suite}.zig`,
          ...(generatedDependency
            ? ["--dep", "capnpc-zig", `-Mgenerated=${output}/root.zig`]
            : []),
          `-Mcapnpc-zig=${root}/build/src/capnp-zig/src/lib_core.zig`,
          `-femit-bin=${executable}`,
        ], root);
        if (target === "wasi") {
          await command(["wasmtime", "run", executable], work);
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
        await command([
          "zig",
          "build-exe",
          "--cache-dir",
          `${root}/.cache/zig-local`,
          ...(target === "wasi" ? ["-target", "wasm32-wasi"] : []),
          "--dep",
          "capnpc-zig",
          "--dep",
          "generated",
          `-Mroot=${root}/tests/reflection/consumer.zig`,
          "--dep",
          "capnpc-zig",
          `-Mgenerated=${output}/root.zig`,
          `-Mcapnpc-zig=${root}/build/src/capnp-zig/src/lib_core.zig`,
          `-femit-bin=${executable}`,
        ], root);
        await command(
          target === "native" ? [executable] : [
            "wasmtime",
            "run",
            "--dir",
            `${directory}::/`,
            executable,
          ],
          directory,
        );
        await command([
          oracle,
          `${work}/request.bin`,
          `${directory}/schema.bin`,
          `${directory}/values.bin`,
          `${directory}/scalars.bin`,
          directory,
        ], root);
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
        equalBytes(
          await Deno.readFile(`${work}/native/${filename}`),
          await Deno.readFile(`${work}/wasi/${filename}`),
          filename,
        );
      }
    },
  );
});
