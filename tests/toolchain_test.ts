const root = Deno.cwd();
const text = new TextDecoder();
const native = `${root}/build/native/bin`;
const wasm = `${root}/build/wasm/bin`;

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function run(
  command: string[],
  input?: Uint8Array,
  cwd = root,
  env?: Record<string, string>,
): Promise<Deno.CommandOutput> {
  const child = new Deno.Command(command[0], {
    args: command.slice(1),
    cwd,
    env,
    stdin: input ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(60_000),
  }).spawn();
  const output = child.output();
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
  return await output;
}

function success(result: Deno.CommandOutput, label: string): Uint8Array {
  assert(
    result.success,
    `${label} exited ${result.code}: ${text.decode(result.stderr)}`,
  );
  return result.stdout;
}

async function copyTree(source: string, destination: string): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = `${source}/${entry.name}`;
    const to = `${destination}/${entry.name}`;
    if (entry.isDirectory) await copyTree(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
    else throw new Error(`unsupported fixture entry ${from}`);
  }
}

async function files(
  directory: string,
  prefix = "",
): Promise<Map<string, Uint8Array>> {
  const result = new Map<string, Uint8Array>();
  for await (const entry of Deno.readDir(directory)) {
    const name = `${prefix}${entry.name}`;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) {
      for (const [key, value] of await files(path, `${name}/`)) {
        result.set(key, value);
      }
    } else if (entry.isFile) result.set(name, await Deno.readFile(path));
    else throw new Error(`unexpected generated entry ${path}`);
  }
  return result;
}

function equalBytes(
  actual: Uint8Array,
  expected: Uint8Array,
  label: string,
): void {
  assert(
    actual.length === expected.length &&
      actual.every((value, i) => value === expected[i]),
    `${label} differs (${actual.length} versus ${expected.length} bytes)`,
  );
}

async function equalFiles(actual: string, expected: string): Promise<void> {
  const left = await files(actual);
  const right = await files(expected);
  assert(
    JSON.stringify([...left.keys()].sort()) ===
      JSON.stringify([...right.keys()].sort()),
    `generated file names differ in ${actual}`,
  );
  for (const [name, bytes] of left) {
    equalBytes(bytes, right.get(name)!, `${actual}/${name}`);
  }
}

async function canonicalRequest(request: Uint8Array): Promise<Uint8Array> {
  return success(
    await run([`${native}/normalize-request`], request),
    "canonicalize CodeGeneratorRequest",
  );
}

async function prepare() {
  await Deno.mkdir(`${root}/build/test`, { recursive: true });
  const work = await Deno.makeTempDir({
    dir: `${root}/build/test`,
    prefix: "toolchain-",
  });
  const compilerRoot = `${work}/input`;
  await copyTree(`${root}/tests/fixtures/schemas`, `${compilerRoot}/src`);
  await Deno.copyFile(
    `${compilerRoot}/src/person.capnp`,
    `${compilerRoot}/src/pérson.capnp`,
  );
  await copyTree(`${root}/tests/fixtures/invalid`, `${compilerRoot}/invalid`);
  await Deno.mkdir(`${compilerRoot}/include/capnp`, { recursive: true });
  await Deno.copyFile(
    `${root}/ref/capnproto/c++/src/capnp/c++.capnp`,
    `${compilerRoot}/include/capnp/c++.capnp`,
  );
  await Deno.copyFile(
    `${root}/ref/go-capnp/std/go.capnp`,
    `${compilerRoot}/include/go.capnp`,
  );
  const request = success(
    await run([
      `${native}/capnp`,
      "compile",
      "--no-standard-import",
      `-I${compilerRoot}/include`,
      `--src-prefix=${compilerRoot}/src`,
      "-o-",
      `${compilerRoot}/src/person.capnp`,
      `${compilerRoot}/src/types/common.capnp`,
    ]),
    "native compiler",
  );
  await Deno.writeFile(`${work}/native-request.bin`, request);
  const expected = `${work}/native-cpp`;
  await Deno.mkdir(expected);
  success(
    await run([`${native}/capnpc-c++`], request, expected),
    "native C++ generator",
  );
  assert(
    (await files(expected)).size === 4,
    "expected two generated header/source pairs",
  );
  for (const language of ["rust", "go", "zig"]) {
    const directory = `${work}/native-${language}`;
    await Deno.mkdir(directory);
    success(
      await run([`${native}/capnpc-${language}`], request, directory),
      `native ${language} generator`,
    );
    assert(
      (await files(directory)).size === 2,
      `expected two ${language} files`,
    );
    if (language === "zig") {
      const upstream = `${work}/upstream-zig`;
      await Deno.mkdir(upstream);
      success(
        await run([`${native}/capnpc-zig-upstream`], request, upstream),
        "unmodified upstream Zig generator",
      );
      await equalFiles(directory, upstream);
    }
  }
  return {
    work,
    compilerRoot,
    request,
    expected,
    semantic: await canonicalRequest(request),
  };
}

let baseline: ReturnType<typeof prepare> | undefined;
const fixture = () => baseline ??= prepare();

const hosts = [
  { name: "wasmtime", command: ["wasmtime", "run", "-W", "exceptions=y"] },
  { name: "wazero", command: [`${root}/build/hosts/wazero-run`] },
  {
    name: "wazero-interpreter",
    command: [`${root}/build/hosts/wazero-run`, "--interpreter"],
  },
  {
    name: "deno",
    command: [
      "deno",
      "run",
      "--unstable-sloppy-imports",
      "--allow-read",
      "--allow-write",
      "--config",
      `${root}/tests/hosts/deno/deno.json`,
      `${root}/tests/hosts/deno/main.ts`,
    ],
  },
];

Deno.test("Wasm artifacts import only WASI Preview 1 and export command entrypoints", async () => {
  for (
    const name of [
      "capnp",
      "capnpc-c++",
      "capnpc-capnp",
      "capnpc-rust",
      "capnpc-go",
      "capnpc-zig",
    ]
  ) {
    const path = `${wasm}/${name}.wasm`;
    success(
      await run([
        "wasm-tools",
        "validate",
        "--features=-legacy-exceptions,-threads,-shared-everything-threads,-memory64",
        path,
      ]),
      `${name} feature profile`,
    );
    const module = await WebAssembly.compile(await Deno.readFile(path));
    for (const imported of WebAssembly.Module.imports(module)) {
      assert(
        imported.module === "wasi_snapshot_preview1",
        `unexpected import ${JSON.stringify(imported)}`,
      );
      // Go's standard WASI runtime retains these two imports even in programs
      // with no networking. None of our hosts gives the guest a socket FD.
      const goRuntimeImport = name === "capnpc-go" &&
        ["sock_accept", "sock_shutdown"].includes(imported.name);
      assert(
        goRuntimeImport || !/^(sock_|thread_)/.test(imported.name),
        `unsupported import ${imported.name}`,
      );
    }
    const exports = WebAssembly.Module.exports(module);
    assert(
      exports.some((item) => item.name === "_start"),
      `${name} lacks _start`,
    );
    assert(
      exports.some((item) => item.name === "memory"),
      `${name} lacks memory`,
    );
  }
});

Deno.test("request comparison rejects trailing stdout and multiple messages", async () => {
  const { request } = await fixture();
  for (
    const suffix of [new TextEncoder().encode("unexpected stdout"), request]
  ) {
    const bytes = new Uint8Array(request.length + suffix.length);
    bytes.set(request);
    bytes.set(suffix, request.length);
    const result = await run([`${native}/normalize-request`], bytes);
    assert(!result.success, "request oracle accepted trailing bytes");
    assert(
      result.stdout.length === 0,
      "request oracle emitted output before checking EOF",
    );
    assert(
      result.stderr.length > 0,
      "request oracle omitted its failure diagnostic",
    );
  }
});

for (const host of hosts) {
  Deno.test(`${host.name}: native parity and failed-job behavior`, async (t) => {
    const data = await fixture();
    const guest = (tool: string, directory: string, args: string[] = []) => [
      ...host.command,
      "--dir",
      `${directory}::/`,
      `${wasm}/${tool}.wasm`,
      ...args,
    ];
    let compiled: Uint8Array = new Uint8Array();

    await t.step(
      "compiler preserves the standard request semantics",
      async () => {
        compiled = success(
          await run(guest("capnp", data.compilerRoot, [
            "compile",
            "--no-standard-import",
            "-I/include",
            "--src-prefix=/src",
            "-o-",
            "/src/person.capnp",
            "/src/types/common.capnp",
          ])),
          `${host.name} compiler`,
        );
        await Deno.writeFile(`${data.work}/${host.name}-request.bin`, compiled);
        const semantic = await canonicalRequest(compiled);
        await Deno.writeFile(
          `${data.work}/${host.name}-canonical.bin`,
          semantic,
        );
        await Deno.writeFile(
          `${data.work}/native-canonical.bin`,
          data.semantic,
        );
        equalBytes(
          semantic,
          data.semantic,
          `request semantics; inspect ${data.work}`,
        );
      },
    );

    for (
      const [source, request] of [["native", data.request], [
        "wasm",
        compiled,
      ]] as const
    ) {
      await t.step(
        `${source} request produces byte-identical C++`,
        async () => {
          assert(request.length > 0, "compiler produced no request");
          const output = `${data.work}/${host.name}-${source}-cpp`;
          await Deno.mkdir(output);
          success(
            await run(guest("capnpc-c++", output), request),
            `${host.name} C++ generator`,
          );
          await equalFiles(output, data.expected);
          success(
            await run([
              "clang++",
              "-std=c++23",
              "-fsyntax-only",
              `-I${root}/ref/capnproto/c++/src`,
              `-I${output}`,
              `${output}/person.capnp.c++`,
              `${output}/types/common.capnp.c++`,
            ]),
            "generated C++ compilation",
          );
        },
      );
    }

    for (const language of ["rust", "go", "zig"]) {
      for (
        const [source, request] of [["native", data.request], [
          "wasm",
          compiled,
        ]] as const
      ) {
        await t.step(
          `${source} request produces byte-identical ${language}`,
          async () => {
            assert(request.length > 0, "compiler produced no request");
            const output = `${data.work}/${host.name}-${source}-${language}`;
            await Deno.mkdir(output);
            const result = await run(
              guest(`capnpc-${language}`, output),
              request,
            );
            success(result, `${host.name} ${language} generator`);
            assert(
              result.stdout.length === 0,
              `${language} generator wrote to binary stdout`,
            );
            await equalFiles(output, `${data.work}/native-${language}`);
          },
        );
      }
      await t.step(
        `generated ${language} compiles and roundtrips with its pinned runtime`,
        async () => {
          const output = `${data.work}/${host.name}-wasm-${language}`;
          if (language === "rust") {
            success(
              await run(
                [
                  "cargo",
                  "test",
                  "--locked",
                  "--manifest-path",
                  `${root}/tests/consumers/rust/Cargo.toml`,
                ],
                undefined,
                root,
                { CAPNP_WASM_GENERATED_DIR: output },
              ),
              "generated Rust roundtrip",
            );
          } else if (language === "go") {
            // Preserve the byte-comparison tree; the consumer owns a separate copy.
            const consumer = `${data.work}/${host.name}-go-consumer`;
            await copyTree(output, consumer);
            await copyTree(`${root}/tests/consumers/go`, consumer);
            success(
              await run([
                "go",
                "-C",
                consumer,
                "mod",
                "edit",
                `-replace=capnproto.org/go/capnp/v3=${root}/ref/go-capnp`,
              ]),
              "select pinned Go runtime",
            );
            success(
              await run([
                "go",
                "-C",
                consumer,
                "test",
                "-mod=readonly",
                "./...",
              ]),
              "generated Go roundtrip",
            );
          } else {
            success(
              await run([
                "zig",
                "test",
                "--cache-dir",
                `${root}/.cache/zig-local`,
                "--dep",
                "capnpc-zig",
                "--dep",
                "generated",
                `-Mroot=${root}/tests/consumers/zig/roundtrip.zig`,
                "--dep",
                "capnpc-zig",
                `-Mgenerated=${output}/person.zig`,
                `-Mcapnpc-zig=${root}/ref/capnp-zig/src/lib_core.zig`,
              ]),
              "generated Zig roundtrip",
            );
          }
        },
      );
    }

    await t.step(
      "Rust output-directory option stages all files beneath the requested path",
      async () => {
        const output = `${data.work}/${host.name}-rust-output-option`;
        await Deno.mkdir(output);
        success(
          await run(
            guest("capnpc-rust", output, ["--output-directory", "/generated"]),
            data.request,
          ),
          "Rust explicit output directory",
        );
        await equalFiles(`${output}/generated`, `${data.work}/native-rust`);
      },
    );

    await t.step("schema inspection matches native output", async () => {
      const expected = success(
        await run([`${native}/capnpc-capnp`], data.request),
        "native inspection",
      );
      const actual = success(
        await run(guest("capnpc-capnp", data.compilerRoot), data.request),
        "Wasm inspection",
      );
      equalBytes(actual, expected, "schema inspection");
    });

    await t.step(
      "UTF-8 entrypoint paths survive WASI argument encoding",
      async () => {
        const request = success(
          await run(guest("capnp", data.compilerRoot, [
            "compile",
            "--no-standard-import",
            "-I/include",
            "--src-prefix=/src",
            "-o-",
            "/src/pérson.capnp",
            "/src/types/common.capnp",
          ])),
          "UTF-8 schema compile",
        );
        const output = `${data.work}/${host.name}-unicode`;
        await Deno.mkdir(output);
        success(
          await run(guest("capnpc-c++", output), request),
          "UTF-8 path generation",
        );
        const generated = await files(output);
        assert(
          generated.has("pérson.capnp.h") && generated.has("pérson.capnp.c++"),
          "UTF-8 output filename was corrupted",
        );
      },
    );

    for (
      const name of ["syntax", "missing-import", "missing-id", "unknown-type"]
    ) {
      await t.step(`${name} fails without producing a request`, async () => {
        const result = await run(guest("capnp", data.compilerRoot, [
          "compile",
          "--no-standard-import",
          "-I/include",
          "-o-",
          `/invalid/${name}.capnp`,
        ]));
        assert(!result.success, `${name} unexpectedly succeeded`);
        assert(
          result.stdout.length === 0,
          `${name} emitted a request despite failure`,
        );
        assert(result.stderr.length > 0, `${name} produced no diagnostic`);
      });
    }

    for (
      const [name, input] of [
        ["empty", new Uint8Array()],
        ["truncated", data.request.slice(0, 12)],
        [
          "invalid-segment-table",
          new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0]),
        ],
      ] as const
    ) {
      for (const language of ["c++", "rust", "go", "zig"]) {
        await t.step(
          `${name} ${language} generator input fails without output files`,
          async () => {
            const output = `${data.work}/${host.name}-${language}-${name}`;
            await Deno.mkdir(output);
            const result = await run(
              guest(`capnpc-${language}`, output),
              input,
            );
            assert(!result.success, `${name} unexpectedly succeeded`);
            assert(
              result.stdout.length === 0,
              `${name} produced stdout despite failure`,
            );
            assert(result.stderr.length > 0, `${name} produced no diagnostic`);
            assert(
              (await files(output)).size === 0,
              `${name} left generated output`,
            );
          },
        );
      }
    }

    await t.step("guest generator launching fails explicitly", async () => {
      const result = await run(guest("capnp", data.compilerRoot, [
        "compile",
        "--no-standard-import",
        "-I/include",
        "--src-prefix=/src",
        "-oc++",
        "/src/person.capnp",
      ]));
      assert(
        !result.success,
        "guest generator launching unexpectedly succeeded",
      );
      assert(
        result.stdout.length === 0,
        "guest generator launching produced stdout",
      );
      assert(
        text.decode(result.stderr).includes("host"),
        "missing host orchestration diagnostic",
      );
    });

    await t.step("id uses host randomness", async () => {
      const output = success(
        await run(guest("capnp", data.compilerRoot, ["id"])),
        "id",
      );
      assert(
        /^@0x[89a-f][0-9a-f]{15}\s*$/.test(text.decode(output)),
        "invalid schema ID",
      );
    });
  });
}
