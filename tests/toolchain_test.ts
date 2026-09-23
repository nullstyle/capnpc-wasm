import { assert, assertBytesEqual, assertTreesEqual } from "./lib/assert.ts";
import { copyTree, readTree } from "./lib/fs.ts";
import { guestCommand, wasmHosts } from "./lib/hosts.ts";
import {
  canonicalRequest,
  nativeCompile,
  stageStandardIncludes,
} from "./lib/oracle.ts";
import { nativeBin, root, wasmBin, zigCacheDir } from "./lib/paths.ts";
import { decodeText, expectSuccess, mustSucceed, run } from "./lib/process.ts";
import { testSuite } from "./lib/workdir.ts";

const suite = testSuite("toolchain-");

async function prepare() {
  const work = await suite.workDir();
  const compilerRoot = `${work}/input`;
  await copyTree(`${root}/tests/fixtures/schemas`, `${compilerRoot}/src`);
  await Deno.copyFile(
    `${compilerRoot}/src/person.capnp`,
    `${compilerRoot}/src/pérson.capnp`,
  );
  await copyTree(`${root}/tests/fixtures/invalid`, `${compilerRoot}/invalid`);
  await stageStandardIncludes(`${compilerRoot}/include`);
  const request = await nativeCompile([
    `${compilerRoot}/src/person.capnp`,
    `${compilerRoot}/src/types/common.capnp`,
  ], {
    include: [`${compilerRoot}/include`],
    srcPrefix: `${compilerRoot}/src`,
  });
  await Deno.writeFile(`${work}/native-request.bin`, request);
  const expected = `${work}/native-cpp`;
  await Deno.mkdir(expected);
  await mustSucceed([`${nativeBin}/capnpc-c++`], {
    stdin: request,
    cwd: expected,
    label: "native C++ generator",
  });
  assert(
    (await readTree(expected)).size === 4,
    "expected two generated header/source pairs",
  );
  for (const language of ["rust", "go", "zig"]) {
    const directory = `${work}/native-${language}`;
    await Deno.mkdir(directory);
    await mustSucceed([`${nativeBin}/capnpc-${language}`], {
      stdin: request,
      cwd: directory,
      label: `native ${language} generator`,
    });
    assert(
      (await readTree(directory)).size === 2,
      `expected two ${language} files`,
    );
    if (language === "zig") {
      // The maintained Zig generator now intentionally adds typed Builder and
      // RPC APIs. --no-reflection disables descriptors, not those improvements;
      // byte identity with the older pristine generator is no longer a contract.
      const withoutReflection = `${work}/zig-without-reflection`;
      await Deno.mkdir(withoutReflection);
      await mustSucceed([`${nativeBin}/capnpc-zig`, "--no-reflection"], {
        stdin: request,
        cwd: withoutReflection,
        label: "Zig generator without reflection metadata",
      });
      const plainFiles = await readTree(withoutReflection);
      const reflectedFiles = await readTree(directory);
      assert(
        JSON.stringify([...plainFiles.keys()]) ===
          JSON.stringify([...reflectedFiles.keys()]),
        "--no-reflection changed generated Zig paths",
      );
      for (const [path, bytes] of plainFiles) {
        const source = decodeText(bytes);
        assert(
          !source.includes("pub const CAPNP_SCHEMA_REQUEST") &&
            !source.includes("pub const capnpSchema"),
          `${path}: --no-reflection retained binary metadata`,
        );
      }
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

suite.test("Wasm artifacts import only WASI Preview 1 and export command entrypoints", async () => {
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
    const path = `${wasmBin}/${name}.wasm`;
    await mustSucceed([
      "wasm-tools",
      "validate",
      "--features=-legacy-exceptions,-threads,-shared-everything-threads,-memory64",
      path,
    ], { label: `${name} feature profile` });
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

suite.test("request comparison rejects trailing stdout and multiple messages", async () => {
  const { request } = await fixture();
  for (
    const suffix of [new TextEncoder().encode("unexpected stdout"), request]
  ) {
    const bytes = new Uint8Array(request.length + suffix.length);
    bytes.set(request);
    bytes.set(suffix, request.length);
    const result = await run([`${nativeBin}/normalize-request`], {
      stdin: bytes,
    });
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

for (const host of wasmHosts) {
  suite.test(`${host.name}: native parity and failed-job behavior`, async (t) => {
    const data = await fixture();
    const guest = (tool: string, directory: string, args: string[] = []) =>
      guestCommand(host, tool, directory, args);
    let compiled: Uint8Array = new Uint8Array();

    await t.step(
      "compiler preserves the standard request semantics",
      async () => {
        compiled = await mustSucceed(
          guest("capnp", data.compilerRoot, [
            "compile",
            "--no-standard-import",
            "-I/include",
            "--src-prefix=/src",
            "-o-",
            "/src/person.capnp",
            "/src/types/common.capnp",
          ]),
          { label: `${host.name} compiler` },
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
        assertBytesEqual(
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
          await mustSucceed(guest("capnpc-c++", output), {
            stdin: request,
            label: `${host.name} C++ generator`,
          });
          await assertTreesEqual(output, data.expected, "generated C++");
          await mustSucceed([
            "clang++",
            "-std=c++23",
            "-fsyntax-only",
            `-I${root}/ref/capnproto/c++/src`,
            `-I${output}`,
            `${output}/person.capnp.c++`,
            `${output}/types/common.capnp.c++`,
          ], { label: "generated C++ compilation" });
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
            const result = await run(guest(`capnpc-${language}`, output), {
              stdin: request,
            });
            expectSuccess(result, `${host.name} ${language} generator`);
            assert(
              result.stdout.length === 0,
              `${language} generator wrote to binary stdout`,
            );
            await assertTreesEqual(
              output,
              `${data.work}/native-${language}`,
              `generated ${language}`,
            );
          },
        );
      }
      if (language === "zig") {
        await t.step(
          "Zig without reflection remains byte-identical to native",
          async () => {
            const output = `${data.work}/${host.name}-zig-without-reflection`;
            await Deno.mkdir(output);
            await mustSucceed(
              guest("capnpc-zig", output, ["--no-reflection"]),
              {
                stdin: data.request,
                label: `${host.name} Zig without reflection`,
              },
            );
            await assertTreesEqual(
              output,
              `${data.work}/zig-without-reflection`,
              "Zig without reflection",
            );
          },
        );
      }
      await t.step(
        `generated ${language} compiles and roundtrips with its pinned runtime`,
        async () => {
          const output = `${data.work}/${host.name}-wasm-${language}`;
          if (language === "rust") {
            // --frozen: the locked graph must already be in the local registry
            // cache (build:rust fetches it), so this step never uses the network.
            await mustSucceed([
              "cargo",
              "test",
              "--frozen",
              "--manifest-path",
              `${root}/tests/consumers/rust/Cargo.toml`,
            ], {
              env: { CAPNPC_WASM_GENERATED_DIR: output },
              label: "generated Rust roundtrip",
            });
          } else if (language === "go") {
            // Preserve the byte-comparison tree; the consumer owns a separate copy.
            const consumer = `${data.work}/${host.name}-go-consumer`;
            await copyTree(output, consumer);
            await copyTree(`${root}/tests/consumers/go`, consumer);
            const offline = { GOFLAGS: "-mod=readonly", GOPROXY: "off" };
            await mustSucceed([
              "go",
              "-C",
              consumer,
              "mod",
              "edit",
              `-replace=capnproto.org/go/capnp/v3=${root}/ref/go-capnp`,
            ], { env: offline, label: "select pinned Go runtime" });
            await mustSucceed([
              "go",
              "-C",
              consumer,
              "test",
              "-mod=readonly",
              "./...",
            ], { env: offline, label: "generated Go roundtrip" });
          } else {
            await mustSucceed([
              "zig",
              "test",
              "--cache-dir",
              zigCacheDir,
              "--dep",
              "capnpc-zig",
              "--dep",
              "generated",
              `-Mroot=${root}/tests/consumers/zig/roundtrip.zig`,
              "--dep",
              "capnpc-zig",
              `-Mgenerated=${output}/person.zig`,
              `-Mcapnpc-zig=${root}/build/src/capnp-zig/src/lib_core.zig`,
            ], { label: "generated Zig roundtrip" });
          }
        },
      );
    }

    await t.step(
      "Rust output-directory option stages all files beneath the requested path",
      async () => {
        const output = `${data.work}/${host.name}-rust-output-option`;
        await Deno.mkdir(output);
        await mustSucceed(
          guest("capnpc-rust", output, ["--output-directory", "/generated"]),
          { stdin: data.request, label: "Rust explicit output directory" },
        );
        await assertTreesEqual(
          `${output}/generated`,
          `${data.work}/native-rust`,
          "Rust explicit output directory",
        );
      },
    );

    await t.step("schema inspection matches native output", async () => {
      const expected = await mustSucceed([`${nativeBin}/capnpc-capnp`], {
        stdin: data.request,
        label: "native inspection",
      });
      const actual = await mustSucceed(
        guest("capnpc-capnp", data.compilerRoot),
        { stdin: data.request, label: "Wasm inspection" },
      );
      assertBytesEqual(actual, expected, "schema inspection");
    });

    await t.step(
      "UTF-8 entrypoint paths survive WASI argument encoding",
      async () => {
        const request = await mustSucceed(
          guest("capnp", data.compilerRoot, [
            "compile",
            "--no-standard-import",
            "-I/include",
            "--src-prefix=/src",
            "-o-",
            "/src/pérson.capnp",
            "/src/types/common.capnp",
          ]),
          { label: "UTF-8 schema compile" },
        );
        const output = `${data.work}/${host.name}-unicode`;
        await Deno.mkdir(output);
        await mustSucceed(guest("capnpc-c++", output), {
          stdin: request,
          label: "UTF-8 path generation",
        });
        const generated = await readTree(output);
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
            const result = await run(guest(`capnpc-${language}`, output), {
              stdin: input,
            });
            assert(!result.success, `${name} unexpectedly succeeded`);
            assert(
              result.stdout.length === 0,
              `${name} produced stdout despite failure`,
            );
            assert(result.stderr.length > 0, `${name} produced no diagnostic`);
            assert(
              (await readTree(output)).size === 0,
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
        decodeText(result.stderr).includes("host"),
        "missing host orchestration diagnostic",
      );
    });

    await t.step("id uses host randomness", async () => {
      const output = await mustSucceed(
        guest("capnp", data.compilerRoot, ["id"]),
        { label: "id" },
      );
      assert(
        /^@0x[89a-f][0-9a-f]{15}\s*$/.test(decodeText(output)),
        "invalid schema ID",
      );
    });
  });
}
