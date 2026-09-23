import {
  assert,
  assertBytesEqual,
  assertTextEqual,
  assertTreesEqual,
  firstDifference,
} from "./lib/assert.ts";
import { copyTree, readTree } from "./lib/fs.ts";
import {
  assertGuestDiagnostic,
  guestCommand,
  TRAP_TEXT,
  wasmHosts,
} from "./lib/hosts.ts";
import {
  canonicalRequest,
  clangxx,
  type DiagnosticNormalization,
  nativeCompile,
  normalizeDiagnostic,
  stageStandardIncludes,
} from "./lib/oracle.ts";
import { nativeBin, root, wasmBin, zigCacheDir } from "./lib/paths.ts";
import {
  decodeText,
  describeExit,
  expectSuccess,
  mustSucceed,
  run,
} from "./lib/process.ts";
import { testSuite } from "./lib/workdir.ts";

const suite = testSuite("toolchain-");

const invalidSchemas = [
  "syntax",
  "missing-import",
  "missing-id",
  "unknown-type",
];
const generators = ["c++", "capnp", "rust", "go", "zig"];
const nativeUsageArgs = ["compile", "--bogus"];
// The plan's `-promises=false -schemas=false` alone is rejected by upstream
// capnpc-go (String() methods need embedded schemas); that rejection is
// compared with native as well.
const goOptionArgs = [
  "-promises=false",
  "-schemas=false",
  "-structstrings=false",
];
const goConflictArgs = ["-schemas=false"];

/** Native reference behaviour for one failing input. */
interface Reference {
  code: number;
  stderr: string;
}

function reference(result: Deno.CommandOutput, label: string): Reference {
  assert(
    result.signal === null && result.code === 1 && result.stdout.length === 0,
    `${label}: native reference ${
      describeExit(result)
    } with ${result.stdout.length} stdout bytes`,
  );
  return { code: result.code, stderr: decodeText(result.stderr) };
}

/**
 * Rewrites every NUL-terminated occurrence of a text in a request, keeping the
 * length so pointers stay valid. "person.capnp" appears twice: as the file
 * node's displayName (which capnpc-c++ uses for output paths) and as the
 * requested file name (which the other generators use).
 */
function patchRequestText(request: Uint8Array, from: string, to: string) {
  const encoder = new TextEncoder();
  const source = encoder.encode(`${from}\0`);
  const target = encoder.encode(`${to}\0`);
  assert(source.length === target.length, "replacement must keep the length");
  const bytes = request.slice();
  let count = 0;
  for (let i = 0; i + source.length <= bytes.length; i++) {
    if (source.every((byte, j) => bytes[i + j] === byte)) {
      bytes.set(target, i);
      count++;
    }
  }
  assert(count === 2, `expected two occurrences of ${from}, found ${count}`);
  return bytes;
}

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
  const inspection = await mustSucceed([`${nativeBin}/capnpc-capnp`], {
    stdin: request,
    label: "native inspection",
  });

  // Native Go generator options: the output must differ from the default
  // output, so the parity step below proves the options took effect.
  const goOptions = `${work}/native-go-options`;
  await Deno.mkdir(goOptions);
  await mustSucceed([`${nativeBin}/capnpc-go`, ...goOptionArgs], {
    stdin: request,
    cwd: goOptions,
    label: "native Go generator with options",
  });
  assert(
    firstDifference(
      await Deno.readFile(`${goOptions}/person.capnp.go`),
      await Deno.readFile(`${work}/native-go/person.capnp.go`),
    ) !== -1,
    "Go options did not change the generated output",
  );
  const goConflictDirectory = `${work}/native-go-option-conflict`;
  await Deno.mkdir(goConflictDirectory);
  const goConflict = reference(
    await run([`${nativeBin}/capnpc-go`, ...goConflictArgs], {
      stdin: request,
      cwd: goConflictDirectory,
    }),
    "native Go option conflict",
  );

  // Native references for every failing input, compared with each host after
  // normalization. The compiler prints paths relative to its working
  // directory, so both spellings of the staging root are stripped.
  const normalization: DiagnosticNormalization = {
    stripPrefixes: [
      `${compilerRoot}/`,
      `${compilerRoot.slice(root.length + 1)}/`,
    ],
    programNames: { [`${nativeBin}/capnp`]: "capnp" },
  };
  const invalid = new Map<string, Reference>();
  for (const name of invalidSchemas) {
    invalid.set(
      name,
      reference(
        await run([
          `${nativeBin}/capnp`,
          "compile",
          "--no-standard-import",
          `-I${compilerRoot}/include`,
          "-o-",
          `${compilerRoot}/invalid/${name}.capnp`,
        ]),
        `native ${name}`,
      ),
    );
  }
  const malformedInputs: [string, Uint8Array][] = [
    ["empty", new Uint8Array()],
    ["truncated", request.slice(0, 12)],
    ["invalid-segment-table", new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0])],
  ];
  const malformed = new Map<string, Reference>();
  for (const [name, input] of malformedInputs) {
    for (const language of generators) {
      const directory = `${work}/native-${language}-${name}`;
      await Deno.mkdir(directory);
      malformed.set(
        `${language}/${name}`,
        reference(
          await run([`${nativeBin}/capnpc-${language}`], {
            stdin: input,
            cwd: directory,
          }),
          `native ${language} ${name}`,
        ),
      );
      assert(
        (await readTree(directory)).size === 0,
        `native ${language} left output for ${name}`,
      );
    }
  }
  const usage = reference(
    await run([`${nativeBin}/capnp`, ...nativeUsageArgs]),
    "native usage error",
  );

  return {
    work,
    compilerRoot,
    request,
    expected,
    inspection,
    semantic: await canonicalRequest(request),
    traversal: patchRequestText(request, "person.capnp", "../out.capnp"),
    normalization,
    invalid,
    malformedInputs,
    malformed,
    usage,
    goConflict,
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

suite.test("request comparison distinguishes schemas and is deterministic", async () => {
  const data = await fixture();
  const other = await nativeCompile([
    `${data.compilerRoot}/src/types/common.capnp`,
  ], {
    include: [`${data.compilerRoot}/include`],
    srcPrefix: `${data.compilerRoot}/src`,
  });
  const semantic = await canonicalRequest(other);
  assert(
    data.semantic.length > 0 && semantic.length > 0,
    "canonical request is empty",
  );
  assert(
    firstDifference(semantic, data.semantic) !== -1,
    "request oracle produced identical canonical output for different schemas",
  );
  assertBytesEqual(
    await canonicalRequest(data.request),
    data.semantic,
    "canonical output of the same request",
  );
});

for (const host of wasmHosts) {
  suite.test(`${host.name}: native parity and failed-job behavior`, async (t) => {
    const data = await fixture();
    const guest = (tool: string, directory: string, args: string[] = []) =>
      guestCommand(host, tool, directory, args);
    const nativeOutput = (language: string) =>
      language === "c++" ? data.expected : `${data.work}/native-${language}`;
    /**
     * A failing guest must behave like native: exit 1, nothing on stdout,
     * the same diagnostic after normalization, and no host path in it.
     */
    const expectNativeDiagnostic = (
      result: Deno.CommandOutput,
      expected: Reference,
      label: string,
    ) => {
      const stderr = assertGuestDiagnostic(result, label);
      assert(
        result.code === expected.code,
        `${label}: exit ${result.code} differs from native exit ${expected.code}`,
      );
      assertTextEqual(
        normalizeDiagnostic(stderr, data.normalization),
        normalizeDiagnostic(expected.stderr, data.normalization),
        `${label}: diagnostic differs from native`,
      );
      assert(
        !stderr.includes(root) && !stderr.includes(".wasm"),
        `${label}: diagnostic leaks the host path or module name:\n${stderr}`,
      );
    };
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
          await mustSucceed(
            clangxx([
              "-std=c++23",
              "-fsyntax-only",
              `-I${root}/ref/capnproto/c++/src`,
              `-I${output}`,
              `${output}/person.capnp.c++`,
              `${output}/types/common.capnp.c++`,
            ]),
            { label: "generated C++ compilation" },
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
              nativeOutput(language),
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

    await t.step("Go generator options match native", async () => {
      const output = `${data.work}/${host.name}-go-options`;
      await Deno.mkdir(output);
      await mustSucceed(guest("capnpc-go", output, goOptionArgs), {
        stdin: data.request,
        label: `${host.name} Go generator with options`,
      });
      await assertTreesEqual(
        output,
        `${data.work}/native-go-options`,
        "Go generator options",
      );
      const conflict = `${data.work}/${host.name}-go-option-conflict`;
      await Deno.mkdir(conflict);
      expectNativeDiagnostic(
        await run(guest("capnpc-go", conflict, goConflictArgs), {
          stdin: data.request,
        }),
        data.goConflict,
        "Go option conflict",
      );
      assert(
        (await readTree(conflict)).size === 0,
        "Go option conflict left generated output",
      );
    });

    await t.step("schema inspection matches native output", async () => {
      for (
        const [source, request] of [["native", data.request], [
          "wasm",
          compiled,
        ]] as const
      ) {
        assert(request.length > 0, "compiler produced no request");
        const actual = await mustSucceed(
          guest("capnpc-capnp", data.compilerRoot),
          { stdin: request, label: `Wasm inspection of the ${source} request` },
        );
        assertBytesEqual(
          actual,
          data.inspection,
          `schema inspection of the ${source} request`,
        );
      }
    });

    await t.step(
      "generators read a regular-file stdin like a pipe",
      async () => {
        const stdinFile = `${data.work}/native-request.bin`;
        for (const language of ["c++", "rust", "go", "zig"]) {
          const output = `${data.work}/${host.name}-${language}-file-stdin`;
          await Deno.mkdir(output);
          await mustSucceed(guest(`capnpc-${language}`, output), {
            stdinFile,
            label: `${host.name} ${language} generator with file stdin`,
          });
          await assertTreesEqual(
            output,
            nativeOutput(language),
            `${language} output from file stdin`,
          );
        }
        assertBytesEqual(
          await mustSucceed(guest("capnpc-capnp", data.compilerRoot), {
            stdinFile,
            label: "Wasm inspection with file stdin",
          }),
          data.inspection,
          "schema inspection from file stdin",
        );
      },
    );

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

    await t.step(
      "usage errors name the tool, not the host module path",
      async () => {
        const result = await run(
          guest("capnp", data.compilerRoot, nativeUsageArgs),
        );
        expectNativeDiagnostic(result, data.usage, "unknown option");
        const stderr = decodeText(result.stderr);
        assert(
          stderr.startsWith("capnp compile: --bogus: unrecognized option") &&
            stderr.includes("Try 'capnp compile --help'"),
          `usage diagnostic does not name the tool:\n${stderr}`,
        );
      },
    );

    for (const name of invalidSchemas) {
      await t.step(`${name} fails with the native diagnostic`, async () => {
        const result = await run(guest("capnp", data.compilerRoot, [
          "compile",
          "--no-standard-import",
          "-I/include",
          "-o-",
          `/invalid/${name}.capnp`,
        ]));
        expectNativeDiagnostic(result, data.invalid.get(name)!, name);
      });
    }

    for (const [name, input] of data.malformedInputs) {
      for (const language of generators) {
        await t.step(
          `${name} ${language} generator input fails with the native diagnostic and no output files`,
          async () => {
            const output = `${data.work}/${host.name}-${language}-${name}`;
            await Deno.mkdir(output);
            const result = await run(guest(`capnpc-${language}`, output), {
              stdin: input,
            });
            expectNativeDiagnostic(
              result,
              data.malformed.get(`${language}/${name}`)!,
              `${name} ${language}`,
            );
            assert(
              (await readTree(output)).size === 0,
              `${name} left generated output`,
            );
          },
        );
      }
    }

    for (const language of generators) {
      await t.step(
        `${language} generator confines a traversal request to the output root`,
        async () => {
          const parent = `${data.work}/${host.name}-${language}-traversal`;
          const output = `${parent}/root`;
          await Deno.mkdir(output, { recursive: true });
          const label = `${language} traversal request`;
          const result = await run(guest(`capnpc-${language}`, output), {
            stdin: data.traversal,
          });
          const stderr = decodeText(result.stderr);
          assert(
            result.signal === null && (result.code === 0 || result.code === 1),
            `${label}: guest ${describeExit(result)}; stderr:\n${stderr}`,
          );
          assert(
            !TRAP_TEXT.test(stderr),
            `${label}: stderr contains runtime trap text:\n${stderr}`,
          );
          const escaped = [...(await readTree(parent)).keys()].filter((path) =>
            !path.startsWith("root/")
          );
          assert(
            escaped.length === 0,
            `${label}: wrote outside the output root: ${escaped.join(", ")}`,
          );
          if (language === "capnp") {
            // Schema inspection writes only stdout; the file name is unused.
            expectSuccess(result, label);
            assert(
              (await readTree(output)).size === 0,
              `${label}: wrote files`,
            );
          } else if (language === "go") {
            // Upstream capnpc-go does not validate names. Every host resolves
            // "../out.capnp.go" against the root, so the file lands inside it.
            assert(result.stdout.length === 0, `${label}: wrote stdout`);
          } else {
            const diagnostic = assertGuestDiagnostic(result, label);
            assert(
              (await readTree(output)).size === 0,
              `${label}: wrote files before rejecting the request`,
            );
            if (language === "rust") {
              // The wrapper validates names itself, so the message is the
              // same on every host and natively instead of a host EPERM.
              assert(
                diagnostic.includes(
                  "is not a relative path inside the output directory",
                ),
                `${label}: expected the wrapper's own rejection, got:\n${diagnostic}`,
              );
            }
          }
        },
      );
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
      const stderr = assertGuestDiagnostic(result, "guest generator launching");
      assert(
        stderr.includes("host"),
        "missing host orchestration diagnostic",
      );
    });

    await t.step("id uses host randomness", async () => {
      const ids: string[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const output = decodeText(
          await mustSucceed(guest("capnp", data.compilerRoot, ["id"]), {
            label: "id",
          }),
        );
        assert(/^@0x[89a-f][0-9a-f]{15}\s*$/.test(output), "invalid schema ID");
        ids.push(output.trim());
      }
      assert(
        ids[0] !== ids[1],
        `two id invocations returned the same value ${
          ids[0]
        }; the host's random source is not random`,
      );
    });
  });
}

suite.test("raw Wasm requests are byte-identical across hosts", async () => {
  const data = await fixture();
  const [first, ...others] = wasmHosts;
  const reference = await Deno.readFile(
    `${data.work}/${first.name}-request.bin`,
  );
  assert(reference.length > 0, `${first.name} produced an empty request`);
  for (const host of others) {
    assertBytesEqual(
      await Deno.readFile(`${data.work}/${host.name}-request.bin`),
      reference,
      `${host.name} raw request versus ${first.name}`,
    );
  }
});
