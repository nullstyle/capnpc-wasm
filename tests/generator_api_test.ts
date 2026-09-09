const root = Deno.cwd();
const decoder = new TextDecoder();
const native = `${root}/build/native/bin`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(args: string[], cwd: string, input?: Uint8Array) {
  const child = new Deno.Command(args[0], {
    args: args.slice(1),
    cwd,
    stdin: input ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(60_000),
  }).spawn();
  const result = child.output();
  if (input) {
    const writer = child.stdin.getWriter();
    try {
      await writer.write(input);
      await writer.close();
    } catch (error) {
      if (!(error instanceof Deno.errors.BrokenPipe)) throw error;
    } finally {
      writer.releaseLock();
    }
  }
  const output = await result;
  assert(
    output.success,
    `${args[0]} exited ${output.code}: ${decoder.decode(output.stderr)}`,
  );
  return output.stdout;
}

Deno.test("Zig concrete generic APIs: native/WASI generation and executable views", async (t) => {
  const cases: { name: string; schema: string; consumer: string }[] = JSON
    .parse(
      await Deno.readTextFile(`${root}/tests/generator_api/cases.json`),
    );
  await Deno.mkdir(`${root}/build/test`, { recursive: true });
  const work = await Deno.makeTempDir({
    dir: `${root}/build/test`,
    prefix: "generator-api-",
  });
  const schemas = `${root}/tests/generator_api/schemas`;
  for (const profile of ["full", "compact"]) {
    for (const schema of new Set(cases.map((c) => c.schema))) {
      await t.step(
        `${profile}/${schema}: native and WASI source parity`,
        async () => {
          const request = await run([
            `${native}/capnp`,
            "compile",
            "--no-standard-import",
            `--src-prefix=${schemas}`,
            "-o-",
            `${schemas}/${schema}`,
          ], root);
          const directory = `${work}/${profile}/${schema}`;
          const a = `${directory}/native`;
          const b = `${directory}/wasi`;
          await Deno.mkdir(a, { recursive: true });
          await Deno.mkdir(b, { recursive: true });
          await Deno.writeFile(`${directory}/request.bin`, request);
          await run(
            [`${native}/capnpc-zig`, `--api-profile=${profile}`],
            a,
            request,
          );
          await run(
            [
              "wasmtime",
              "run",
              "--dir",
              `${b}::/`,
              `${root}/build/wasm/bin/capnpc-zig.wasm`,
              `--api-profile=${profile}`,
            ],
            root,
            request,
          );
          const filename = schema.replace(/\.capnp$/, ".zig");
          const expected = await Deno.readFile(`${a}/${filename}`);
          const actual = await Deno.readFile(`${b}/${filename}`);
          assert(
            actual.length === expected.length &&
              actual.every((byte, i) => byte === expected[i]),
            `${profile}/${schema}: generated sources differ`,
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
            await run([
              "zig",
              "test",
              "--cache-dir",
              `${root}/build/zig/cache`,
              ...(target === "wasi"
                ? ["-target", "wasm32-wasi", "--test-no-exec"]
                : []),
              "--dep",
              "capnpc-zig",
              `-Mroot=${directory}/${fixture.consumer}`,
              `-Mcapnpc-zig=${root}/build/src/capnp-zig/src/lib_core.zig`,
              `-femit-bin=${executable}`,
            ], root);
            if (target === "wasi") {
              await run(["wasmtime", "run", executable], root);
            }
          },
        );
      }
    }
  }
});
