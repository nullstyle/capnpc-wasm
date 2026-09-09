const root = Deno.cwd();
const decoder = new TextDecoder();
const native = `${root}/build/native/bin`;
const runtime = `${root}/build/src/capnp-zig/src`;

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

async function outputFiles(directory: string, prefix = "") {
  const result = new Map<string, Uint8Array>();
  for await (const entry of Deno.readDir(directory)) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory) {
      for (
        const [name, bytes] of await outputFiles(
          `${directory}/${entry.name}`,
          `${path}/`,
        )
      ) result.set(name, bytes);
    } else {
      assert(entry.isFile, `unexpected generated file type: ${path}`);
      result.set(path, await Deno.readFile(`${directory}/${entry.name}`));
    }
  }
  return result;
}

Deno.test("Zig RPC APIs: native/WASI paths, inherited dispatch, and streaming", async (t) => {
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
  await Deno.mkdir(`${root}/build/test`, { recursive: true });
  const work = await Deno.makeTempDir({
    dir: `${root}/build/test`,
    prefix: "rpc-codegen-",
  });
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
          const request = await run([
            `${native}/capnp`,
            "compile",
            "--no-standard-import",
            `-I${runtime}/rpc`,
            `--src-prefix=${schemas}`,
            "-o-",
            ...fixture.schemas.map((schema) => `${schemas}/${schema}`),
          ], root);
          await Deno.mkdir(a, { recursive: true });
          await Deno.mkdir(b, { recursive: true });
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
          const expected = await outputFiles(a);
          const actual = await outputFiles(b);
          const names = fixture.schemas.map((s) =>
            s.replace(/\.capnp$/, ".zig")
          )
            .sort();
          assert(
            JSON.stringify([...expected.keys()].sort()) ===
                JSON.stringify(names) &&
              JSON.stringify([...actual.keys()].sort()) ===
                JSON.stringify(names),
            `${profile}/${fixture.name}: unexpected generated paths`,
          );
          for (const [path, bytes] of expected) {
            const other = actual.get(path)!;
            assert(
              bytes.length === other.length &&
                bytes.every((byte, i) => byte === other[i]),
              `${profile}/${fixture.name}/${path}: generated sources differ`,
            );
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
              "--dep",
              "capnpc-zig",
              `-Mcapnpc-zig=${runtime}/lib.zig`,
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
