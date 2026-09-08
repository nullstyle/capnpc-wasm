import {
  type Compiler,
  createCompiler,
  type Language,
} from "../sdk/typescript/mod.ts";

const root = Deno.cwd();
const native = `${root}/build/native/bin`;
const fixtures = `${root}/tests/fixtures/features`;
const decoder = new TextDecoder();
const tools = {
  cpp: "capnpc-c++",
  rust: "capnpc-rust",
  go: "capnpc-go",
  zig: "capnpc-zig",
};
const manifest: {
  files: string[];
  scenarios: { name: string; entrypoints: string[]; generators: Language[] }[];
} = JSON.parse(await Deno.readTextFile(`${fixtures}/manifest.json`));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equalBytes(actual: Uint8Array, expected: Uint8Array, name: string) {
  assert(actual.length === expected.length, `${name}: byte length differs`);
  const offset = actual.findIndex((byte, i) => byte !== expected[i]);
  assert(offset === -1, `${name}: bytes differ at offset ${offset}`);
}

// Only the documented 0003 substitutions are allowed for this fixture. Keep
// occurrence counts exact so unrelated output changes cannot pass as fixes.
function helperNameQualifications(upstream: Uint8Array): Uint8Array {
  let source = decoder.decode(upstream);
  const changes = [
    [
      "const schema = capnpc.schema;\n",
      "const schema = capnpc.schema;\nconst _capnp_file = @This();\n",
      1,
    ],
    [
      "error{InvalidEnumValue}!WhichTag {",
      "error{InvalidEnumValue}!_capnp_file.WhichTag.WhichTag {",
      1,
    ],
    [
      "std.enums.fromInt(WhichTag,",
      "std.enums.fromInt(_capnp_file.WhichTag.WhichTag,",
      1,
    ],
    ["EnumOrdinals.State", "_capnp_file.EnumOrdinals.State", 3],
    [
      "fn enumOrdinals(self: @This()) EnumOrdinals {",
      "fn enumOrdinals(self: @This()) @This().EnumOrdinals {",
      4,
    ],
    [
      "fn getEnumOrdinals(self: Reader) EnumOrdinals.Reader {",
      "fn getEnumOrdinals(self: Reader) GroupViews.EnumOrdinals.Reader {",
      1,
    ],
    [
      "fn getEnumOrdinals(self: *Builder) EnumOrdinals.Builder {",
      "fn getEnumOrdinals(self: *Builder) GroupViews.EnumOrdinals.Builder {",
      1,
    ],
    [
      "fn nestedLists(self: @This()) NestedLists {",
      "fn nestedLists(self: @This()) @This().NestedLists {",
      2,
    ],
    [
      "fn pointerKinds(self: @This()) PointerKinds {",
      "fn pointerKinds(self: @This()) @This().PointerKinds {",
      2,
    ],
  ] as const;
  for (const [before, after, count] of changes) {
    assert(
      source.split(before).length - 1 === count,
      `unexpected upstream helper-names template: ${before}`,
    );
    source = source.replaceAll(before, after);
  }
  return new TextEncoder().encode(source);
}

async function command(
  args: string[],
  cwd: string,
  stdin?: Uint8Array,
): Promise<Uint8Array> {
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

async function writeFiles(
  directory: string,
  files: Record<string, Uint8Array>,
) {
  for (const [name, bytes] of Object.entries(files)) {
    const path = `${directory}/${name}`;
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeFile(path, bytes);
  }
}

async function outputFiles(directory: string, prefix = "") {
  const files: Record<string, Uint8Array> = {};
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory) {
      Object.assign(files, await outputFiles(path, `${name}/`));
    } else {
      assert(entry.isFile, `unexpected generated entry ${path}`);
      files[name] = await Deno.readFile(path);
    }
  }
  return files;
}

let compilerPromise: Promise<Compiler>;
function compiler() {
  return compilerPromise ??= (async () => {
    const wasm = `${root}/build/wasm/bin`;
    return await createCompiler({
      compiler: await Deno.readFile(`${wasm}/capnp.wasm`),
      generators: {
        cpp: await Deno.readFile(`${wasm}/capnpc-c++.wasm`),
        rust: await Deno.readFile(`${wasm}/capnpc-rust.wasm`),
        go: await Deno.readFile(`${wasm}/capnpc-go.wasm`),
        zig: await Deno.readFile(`${wasm}/capnpc-zig.wasm`),
      },
    });
  })();
}

for (const scenario of manifest.scenarios) {
  Deno.test(`TypeScript SDK schema features: ${scenario.name}`, async (t) => {
    await Deno.mkdir(`${root}/build/test`, { recursive: true });
    const work = await Deno.makeTempDir({
      dir: `${root}/build/test`,
      prefix: `features-${scenario.name}-`,
    });
    const files: Record<string, Uint8Array> = {};
    for (const name of manifest.files) {
      files[name] = await Deno.readFile(`${fixtures}/workspace/${name}`);
    }
    const includeFiles = {
      "capnp/c++.capnp": await Deno.readFile(
        `${root}/ref/capnproto/c++/src/capnp/c++.capnp`,
      ),
      "go.capnp": await Deno.readFile(`${root}/ref/go-capnp/std/go.capnp`),
    };
    await writeFiles(`${work}/src`, files);
    await writeFiles(`${work}/include`, includeFiles);
    const nativeRequest = await command([
      `${native}/capnp`,
      "compile",
      "--no-standard-import",
      `-I${work}/include`,
      `--src-prefix=${work}/src`,
      "-o-",
      ...scenario.entrypoints.map((name) => `${work}/src/${name}`),
    ], work);
    const result = await (await compiler()).compile({
      files,
      includeFiles,
      entrypoints: scenario.entrypoints,
      generators: scenario.generators,
    });
    assert(result.diagnostics.length === 0, "unexpected SDK diagnostics");
    await Deno.writeFile(`${work}/native-request.bin`, nativeRequest);
    await Deno.writeFile(`${work}/sdk-request.bin`, result.request);

    await t.step(
      "canonical full CodeGeneratorRequest equals native",
      async () => {
        equalBytes(
          await command([`${native}/normalize-request`], work, result.request),
          await command([`${native}/normalize-request`], work, nativeRequest),
          `${scenario.name}: canonical request`,
        );
      },
    );

    for (const language of scenario.generators) {
      await t.step(`${language} generated bytes equal native`, async () => {
        const nativeOutput = `${work}/native-${language}`;
        await Deno.mkdir(nativeOutput);
        const stdout = await command(
          [`${native}/${tools[language]}`],
          nativeOutput,
          nativeRequest,
        );
        assert(stdout.length === 0, `${language}: unexpected native stdout`);
        const expected = await outputFiles(nativeOutput);
        if (
          language === "zig" &&
          (scenario.name === "values" || scenario.name === "helper-names")
        ) {
          const upstream = `${work}/upstream-zig`;
          await Deno.mkdir(upstream);
          await command(
            [`${native}/capnpc-zig-upstream`],
            upstream,
            nativeRequest,
          );
          const unmodified = await outputFiles(upstream);
          assert(
            JSON.stringify(Object.keys(unmodified).sort()) ===
              JSON.stringify(Object.keys(expected).sort()),
            "Zig patch changed upstream output paths",
          );
          for (const [path, bytes] of Object.entries(unmodified)) {
            equalBytes(
              expected[path],
              scenario.name === "helper-names"
                ? helperNameQualifications(bytes)
                : bytes,
              `upstream Zig/${path}`,
            );
          }
        }
        const actual = result.outputs[language]!;
        assert(
          Object.keys(expected).length ===
            scenario.entrypoints.length * (language === "cpp" ? 2 : 1),
          `${language}: unexpected native output count`,
        );
        assert(
          JSON.stringify(Object.keys(actual).sort()) ===
            JSON.stringify(Object.keys(expected).sort()),
          `${language}: output paths differ`,
        );
        for (const [path, bytes] of Object.entries(expected)) {
          equalBytes(actual[path], bytes, `${language}/${path}`);
        }
      });
    }

    await t.step("generated C++ defaults and pointers roundtrip", async () => {
      const output = `${work}/sdk-cpp`;
      await writeFiles(output, result.outputs.cpp!);
      const executable = `${work}/consumer`;
      await command([
        "clang++",
        "-std=c++23",
        `-I${root}/ref/capnproto/c++/src`,
        `-I${output}`,
        `${fixtures}/consumers/${scenario.name}.c++`,
        ...Object.keys(result.outputs.cpp!).filter((path) =>
          path.endsWith(".c++")
        ).map((path) => `${output}/${path}`),
        `${root}/build/native/lib/libcapnp.a`,
        `${root}/build/native/lib/libkj.a`,
        "-pthread",
        "-o",
        executable,
      ], work);
      await command([executable], work);
    });

    if (scenario.generators.includes("zig")) {
      await t.step(
        "generated Zig defaults and pointers roundtrip",
        async () => {
          const output = `${work}/sdk-zig`;
          await writeFiles(output, result.outputs.zig!);
          // Keep nested generated imports inside the Zig module's root.
          await Deno.writeTextFile(
            `${output}/root.zig`,
            `pub const schema = @import("${
              scenario.entrypoints[0].replace(/\.capnp$/, ".zig")
            }");\n`,
          );
          await command([
            "zig",
            "test",
            "--cache-dir",
            `${root}/.cache/zig-local`,
            "--dep",
            "capnpc-zig",
            "--dep",
            "generated",
            `-Mroot=${root}/tests/consumers/zig/${scenario.name}.zig`,
            "--dep",
            "capnpc-zig",
            `-Mgenerated=${
              scenario.name === "values"
                ? `${output}/values.zig`
                : `${output}/root.zig`
            }`,
            `-Mcapnpc-zig=${root}/ref/capnp-zig/src/lib_core.zig`,
          ], root);
        },
      );
    }
  });
}
