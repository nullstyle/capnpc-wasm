const text = new TextDecoder();
const bytes = new TextEncoder();

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function run(
  args: string[],
  input?: Uint8Array,
  env?: Record<string, string>,
): Promise<Deno.CommandOutput> {
  const child = new Deno.Command(args[0], {
    args: args.slice(1),
    env,
    stdin: input ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(60_000),
  }).spawn();
  const output = child.output();
  if (input) {
    try {
      await new Blob([new Uint8Array(input)]).stream().pipeTo(child.stdin);
    } catch (error) {
      if (!(error instanceof Deno.errors.BrokenPipe)) throw error;
    }
  }
  return await output;
}

function success(output: Deno.CommandOutput): Uint8Array {
  assert(output.success, text.decode(output.stderr));
  return output.stdout;
}

function equal(actual: Uint8Array, expected: Uint8Array, label: string) {
  assert(
    actual.length === expected.length &&
      actual.every((value, index) => value === expected[index]),
    `${label}: bytes differ`,
  );
}

/** Exercise the installed launcher and real compiler/generator, outside the package. */
export async function checkLauncher(
  packagePath: string,
  generatorPackagePath = packagePath,
): Promise<void> {
  await Deno.mkdir("build/test", { recursive: true });
  const temporary = await Deno.realPath(
    await Deno.makeTempDir({
      dir: "build/test",
      prefix: "launcher with spaces ",
    }),
  );
  try {
    const pkg = `${temporary}/package with spaces`;
    for (const file of await packageFiles(packagePath)) {
      if (!/^(bin|runtime|wasm|include)\//.test(file)) continue;
      const destination = `${pkg}/${file}`;
      await Deno.mkdir(destination.slice(0, destination.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.copyFile(`${packagePath}/${file}`, destination);
    }
    const generatorPackage = await Deno.realPath(generatorPackagePath);
    const workspace = `${temporary}/input with spaces`;
    const output = `${temporary}/output with spaces`;
    const oracle = `${temporary}/direct output`;
    for (const dir of [workspace, output, oracle]) {
      await Deno.mkdir(dir);
    }
    await Deno.mkdir(`${workspace}/include/capnp`, { recursive: true });
    await Deno.copyFile(
      `${pkg}/include/capnp/c++.capnp`,
      `${workspace}/include/capnp/c++.capnp`,
    );
    await Deno.writeTextFile(
      `${workspace}/schema with spaces.capnp`,
      '@0xece4bf9c1f867623; using Cxx = import "/capnp/c++.capnp"; $Cxx.namespace("candidate"); struct Candidate { value @0 :Data; }\n',
    );
    const launcher = ["bash", `${pkg}/bin/capnp-wasm`];
    const compiler = [
      ...launcher,
      "compiler",
      "--workspace",
      workspace,
      "--",
    ];
    const direct = [
      "wasmtime",
      "run",
      "-W",
      "exceptions=y",
      "-S",
      "cwd=/",
      "--dir",
      `${workspace}::/`,
      `${pkg}/wasm/capnp.wasm`,
    ];
    const schemaArgs = [
      "--no-standard-import",
      "-I/include",
      "/schema with spaces.capnp",
    ];
    const compileArgs = [
      "compile",
      "--src-prefix=/",
      "-o-",
      ...schemaArgs,
    ];
    const request = success(await run([...compiler, ...compileArgs]));
    equal(
      request,
      success(await run([...direct, ...compileArgs])),
      "compiler binary request",
    );
    assert(
      request.includes(0),
      "compiler request does not contain binary NULs",
    );
    for (const generator of ["capnpc-c++", "capnpc-zig"]) {
      const module = `${generatorPackage}/wasm/${generator}.wasm`;
      success(
        await run([
          ...launcher,
          "generator",
          "--module",
          module,
          "--output",
          output,
          "--",
        ], request),
      );
      success(
        await run([
          "wasmtime",
          "run",
          "-W",
          "exceptions=y",
          "-S",
          "cwd=/",
          "--dir",
          `${oracle}::/`,
          module,
        ], request),
      );
    }
    for (
      const file of [
        "schema with spaces.capnp.h",
        "schema with spaces.capnp.c++",
        "schema with spaces.zig",
      ]
    ) {
      equal(
        await Deno.readFile(`${output}/${file}`),
        await Deno.readFile(`${oracle}/${file}`),
        file,
      );
    }
    const encoded = success(
      await run(
        [...compiler, "encode", ...schemaArgs, "Candidate"],
        bytes.encode('(value = 0x"000102ff0080")'),
      ),
    );
    const canonical = success(
      await run(
        [...compiler, "convert", "binary:canonical"],
        encoded,
      ),
    );
    equal(
      canonical,
      success(await run([...direct, "convert", "binary:canonical"], encoded)),
      "binary canonicalization",
    );
    equal(
      canonical,
      success(
        await run(
          [...compiler, "convert", "flat:canonical"],
          canonical,
        ),
      ),
      "canonical idempotence",
    );
    await Deno.writeTextFile(`${workspace}/bad.capnp`, "invalid schema");
    const invalidArgs = ["compile", "-o-", "/bad.capnp"];
    const invalid = await run([...compiler, ...invalidArgs]);
    const invalidDirect = await run([...direct, ...invalidArgs]);
    assert(
      !invalid.success && invalid.code === invalidDirect.code &&
        invalid.stderr.length > 0,
      "invalid schema status/diagnostics were lost",
    );
    const malformed = await run([
      ...launcher,
      "generator",
      "--module",
      `${generatorPackage}/wasm/capnpc-zig.wasm`,
      "--output",
      output,
      "--",
    ], new Uint8Array([0, 1, 2]));
    assert(!malformed.success, "malformed generator request succeeded");
    for (
      const args of [
        [],
        ["compiler", "--workspace", "relative", "--", "--version"],
        ["compiler", "--workspace", `${workspace}::/escape`, "--", "--version"],
        ["compiler", "--workspace", `${workspace}/missing`, "--", "--version"],
        ["compiler", "--workspace", workspace, "--version"],
        ["compiler", "--workspace", workspace, "--dir", "/", "--", "--version"],
        ["generator", "--module", "relative.wasm", "--output", output, "--"],
      ]
    ) {
      assert(
        !(await run([...launcher, ...args])).success,
        `invalid launcher arguments accepted: ${JSON.stringify(args)}`,
      );
    }
    assert(
      !(await run([...compiler, "--version"], undefined, {
        CAPNP_WASM_WASMTIME: `${temporary}/missing runtime`,
      })).success,
      "missing runtime accepted",
    );
    const runtime = `${temporary}/runtime with spaces`;
    await Deno.writeTextFile(runtime, '#!/bin/sh\nexec wasmtime "$@"\n');
    await Deno.chmod(runtime, 0o755);
    success(
      await run([...compiler, "--version"], undefined, {
        CAPNP_WASM_WASMTIME: runtime,
      }),
    );
    await Deno.writeTextFile(
      runtime,
      '#!/bin/sh\nprintf "wasmtime 0.0.0\\n"\n',
    );
    const wrongVersion = await run([...compiler, "--version"], undefined, {
      CAPNP_WASM_WASMTIME: runtime,
    });
    assert(
      wrongVersion.code === 78 &&
        text.decode(wrongVersion.stderr).includes("expected Wasmtime"),
      "wrong runtime version accepted",
    );
    console.log(
      "Packaged launcher passed: real compiler/C++/Zig, binary canonicalization, paths with spaces, failures, and runtime pin",
    );
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
}

if (import.meta.main) {
  const metadata = JSON.parse(await Deno.readTextFile("release.json"));
  await checkLauncher(
    Deno.args[0] ?? `dist/releases/capnpc-wasm-${metadata.version}/package`,
  );
}
import { packageFiles } from "../../scripts/verify-release.ts";
