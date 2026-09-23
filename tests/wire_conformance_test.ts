import { assert, assertBytesEqual } from "./lib/assert.ts";
import { nativeBin, root, zigCacheDir } from "./lib/paths.ts";
import { decodeText, mustSucceed, run } from "./lib/process.ts";
import { testSuite } from "./lib/workdir.ts";

const suite = testSuite("wire-conformance-");

type ListCase = {
  name: string;
  landing: number;
  content: number;
  count: number;
  dataWords: number;
  pointerWords: number;
  prefill?: boolean;
};

const listCases: ListCase[] = [
  {
    name: "distinct-data-list",
    landing: 1,
    content: 2,
    count: 2,
    dataWords: 1,
    pointerWords: 0,
  },
  {
    name: "source-landing-data-list",
    landing: 0,
    content: 1,
    count: 2,
    dataWords: 1,
    pointerWords: 0,
  },
  {
    name: "source-content-data-list",
    landing: 1,
    content: 0,
    count: 2,
    dataWords: 1,
    pointerWords: 0,
  },
  {
    name: "source-content-large-list",
    landing: 1,
    content: 0,
    count: 257,
    dataWords: 1,
    pointerWords: 0,
  },
  {
    name: "distinct-empty-list",
    landing: 1,
    content: 2,
    count: 0,
    dataWords: 1,
    pointerWords: 0,
  },
  {
    name: "distinct-zero-width-list",
    landing: 1,
    content: 2,
    count: 2,
    dataWords: 0,
    pointerWords: 0,
  },
  {
    name: "distinct-empty-zero-width-list",
    landing: 1,
    content: 2,
    count: 0,
    dataWords: 0,
    pointerWords: 0,
  },
  {
    name: "distinct-pointer-list",
    landing: 1,
    content: 2,
    count: 2,
    dataWords: 1,
    pointerWords: 1,
    prefill: true,
  },
  {
    name: "source-landing-pointer-list",
    landing: 0,
    content: 1,
    count: 2,
    dataWords: 1,
    pointerWords: 1,
    prefill: true,
  },
  {
    name: "source-content-pointer-list",
    landing: 1,
    content: 0,
    count: 2,
    dataWords: 1,
    pointerWords: 1,
    prefill: true,
  },
];

function checkWireWords(
  bytes: Uint8Array,
  fixture: ListCase,
  canonical: boolean,
) {
  const frame = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segmentCount = frame.getUint32(0, true) + 1;
  assert(
    segmentCount === Math.max(fixture.landing, fixture.content) + 1,
    `${fixture.name}: segment count`,
  );
  let offset = Math.ceil((segmentCount + 1) / 2) * 8;
  const segments: DataView[] = [];
  for (let index = 0; index < segmentCount; index++) {
    const length = frame.getUint32((index + 1) * 4, true) * 8;
    segments.push(
      new DataView(bytes.buffer, bytes.byteOffset + offset, length),
    );
    offset += length;
  }
  assert(offset === bytes.length, `${fixture.name}: framing length`);
  const word = (segment: number, index: number) =>
    segments[segment].getBigUint64(index * 8, true);
  const equalWord = (actual: bigint, expected: bigint, what: string) => {
    assert(
      actual === expected,
      `${fixture.name}: ${what}: expected ${expected.toString(16)}, got ${
        actual.toString(16)
      }`,
    );
  };
  const padding = fixture.prefill ? 1 : 0;
  const landingOffset = (fixture.landing === 0 ? 2 : 0) + padding;
  const contentOffset = (fixture.content === 0 ? 2 : 0) + padding;
  const far = (segment: number, target: number, double: boolean) =>
    (BigInt(segment) << 32n) | (BigInt(target) << 3n) | (double ? 6n : 2n);
  const elementTag = (BigInt(fixture.pointerWords) << 48n) |
    (BigInt(fixture.dataWords) << 32n) | (BigInt(fixture.count) << 2n);
  const totalWords = fixture.count * (fixture.dataWords + fixture.pointerWords);
  equalWord(word(0, 0), 0x0001000000000000n, "root struct");
  equalWord(
    word(0, 1),
    far(fixture.landing, landingOffset, true),
    "double-far pointer",
  );
  equalWord(
    word(fixture.landing, landingOffset),
    far(fixture.content, contentOffset, false),
    "content far pointer",
  );
  equalWord(
    word(fixture.landing, landingOffset + 1),
    canonical ? (BigInt(totalWords) << 35n) | (7n << 32n) | 1n : elementTag,
    "landing tag (word count excludes content tag)",
  );
  if (canonical) {
    equalWord(
      word(fixture.content, contentOffset),
      elementTag,
      "in-content element tag",
    );
  }
  if (fixture.prefill) {
    equalWord(
      word(fixture.landing, landingOffset - 1),
      0xfeedn,
      "existing landing data",
    );
    equalWord(
      word(fixture.content, contentOffset - 1),
      0xbeefn,
      "existing content data",
    );
  }
  const elementsOffset = contentOffset + (canonical ? 1 : 0);
  assert(
    segments[fixture.content].byteLength >= (elementsOffset + totalWords) * 8,
    `${fixture.name}: element storage`,
  );
  if (fixture.dataWords > 0) {
    for (let index = 0; index < fixture.count; index++) {
      equalWord(
        word(
          fixture.content,
          elementsOffset + index * (fixture.dataWords + fixture.pointerWords),
        ),
        index === 0 ? 42n : 99n,
        `element ${index}`,
      );
    }
  }
}

function listExpectation(fixture: ListCase) {
  const type = fixture.pointerWords
    ? "PointerListRoot"
    : fixture.dataWords
    ? "ListRoot"
    : "EmptyListRoot";
  const values = Array.from({ length: fixture.count }, (_, index) => {
    if (!fixture.dataWords) return "()";
    const value = index === 0 ? 42 : 99;
    return fixture.pointerWords
      ? `(value = ${value}, text = "${index === 0 ? "first" : "second"}")`
      : `(value = ${value})`;
  });
  return { type, expected: `(items = [${values.join(", ")}])` };
}

suite.test("Zig wire conformance against reference C++", async (t) => {
  const work = await suite.workDir();
  const variants = [
    {
      name: "upstream",
      source: "build/src/capnp-zig-historical",
      canonical: false,
      wasm: false,
    },
    {
      name: "patched",
      source: "build/src/capnp-zig",
      canonical: true,
      wasm: false,
    },
    {
      name: "patched-wasi",
      source: "build/src/capnp-zig",
      canonical: true,
      wasm: true,
    },
  ];

  async function decode(directory: string, name: string, type: string) {
    const result = await run([
      `${nativeBin}/capnp`,
      "decode",
      "--short",
      `${root}/tests/wire/probe.capnp`,
      type,
    ], { stdin: await Deno.readFile(`${directory}/${name}.bin`) });
    await Deno.writeFile(`${directory}/${name}.stdout.txt`, result.stdout);
    await Deno.writeFile(`${directory}/${name}.stderr.txt`, result.stderr);
    return result;
  }

  const controls = [
    {
      name: "same-segment-list",
      type: "ListRoot",
      expected: "(items = [(value = 42), (value = 99)])",
    },
    {
      name: "single-far-list",
      type: "ListRoot",
      expected: "(items = [(value = 42), (value = 99)])",
    },
    {
      name: "canonical-double-far-list",
      type: "ListRoot",
      expected: "(items = [(value = 42), (value = 99)])",
    },
    {
      name: "canonical-double-far-tree",
      type: "Node",
      expected: "(child = (value = 42), value = 0)",
    },
    { name: "valid-text", type: "TextRoot", expected: '(text = "wire text")' },
  ];
  async function expectDecoded(
    directory: string,
    name: string,
    type: string,
    expected: string,
  ) {
    const result = await decode(directory, name, type);
    assert(
      result.success,
      `${name}: C++ decode exited ${result.code}: ${decodeText(result.stderr)}`,
    );
    const actual = decodeText(result.stdout).replace(/\s+/g, " ").trim();
    assert(
      actual === expected,
      `${name}: expected ${expected}, got ${actual}`,
    );
    assert(result.stderr.length === 0, `${name}: unexpected C++ diagnostics`);
  }

  async function expectRejected(
    directory: string,
    name: string,
    type: string,
    diagnostic: string,
  ) {
    const result = await decode(directory, name, type);
    assert(
      !result.success && result.signal === null && result.code === 1,
      `${name}: expected C++ validation rejection (exit 1), got exit ${result.code}, signal ${result.signal}; review known-failure expectations if the runtime changes`,
    );
    assert(
      decodeText(result.stderr).includes(diagnostic),
      `${name}: expected ${diagnostic}, got ${decodeText(result.stderr)}`,
    );
  }

  const layoutDiagnostic = "expected ref->kind() == WirePointer::LIST [0 == 1]";
  for (const variant of variants) {
    const directory = `${work}/${variant.name}`;
    await Deno.mkdir(directory);
    const options = `${directory}/probe-options.zig`;
    await Deno.writeTextFile(
      options,
      `pub const patched_validation = ${variant.canonical};\n`,
    );
    const executable = `${directory}/probe${variant.wasm ? ".wasm" : ""}`;
    const passed = await t.step(
      `${variant.name}: Zig values, mutable reopen, legacy reads, and validation`,
      async () => {
        await mustSucceed([
          "zig",
          "build-exe",
          ...(variant.wasm ? ["-target", "wasm32-wasi"] : []),
          "--cache-dir",
          zigCacheDir,
          "--dep",
          "capnpc-zig",
          "--dep",
          "probe-options",
          `-Mroot=${root}/tests/wire/probe.zig`,
          `-Mcapnpc-zig=${root}/${variant.source}/src/lib_core.zig`,
          `-Mprobe-options=${options}`,
          `-femit-bin=${executable}`,
        ], { label: `${variant.name} probe build` });
        await mustSucceed(
          variant.wasm
            ? ["wasmtime", "run", `--dir=${directory}::.`, executable]
            : [executable],
          { cwd: directory, label: `${variant.name} probe` },
        );
      },
    );
    if (!passed) return;

    for (const { name, type, expected } of controls) {
      await t.step(
        `${variant.name}: C++ decodes ${name}`,
        () => expectDecoded(directory, name, type, expected),
      );
    }
    for (const fixture of listCases) {
      await t.step(
        `${variant.name}: ${
          variant.canonical ? "canonical" : "known W1"
        } ${fixture.name}`,
        async () => {
          checkWireWords(
            await Deno.readFile(`${directory}/${fixture.name}.bin`),
            fixture,
            variant.canonical,
          );
          const { type, expected } = listExpectation(fixture);
          if (variant.canonical) {
            await expectDecoded(directory, fixture.name, type, expected);
          } else {
            await expectRejected(
              directory,
              fixture.name,
              type,
              fixture.count * (fixture.dataWords + fixture.pointerWords) === 0
                ? "expected newSegment != nullptr [0 != nullptr]; Message contains double-far pointer to unknown segment."
                : layoutDiagnostic,
            );
          }
        },
      );
    }
    await t.step(
      `${variant.name}: independent legacy Layout A remains reference-rejected`,
      () =>
        expectRejected(
          directory,
          "legacy-layout-a-list",
          "ListRoot",
          layoutDiagnostic,
        ),
    );
    await t.step(
      `${variant.name}: C++ and strict Zig reject non-NUL Text`,
      () =>
        expectRejected(
          directory,
          "missing-nul",
          "TextRoot",
          "Message contains text that is not NUL-terminated",
        ),
    );
    await t.step(
      `${variant.name}: writer equals independent encoding fixture`,
      async () => {
        assertBytesEqual(
          await Deno.readFile(`${directory}/distinct-data-list.bin`),
          await Deno.readFile(
            `${directory}/${
              variant.canonical
                ? "canonical-double-far-list"
                : "legacy-layout-a-list"
            }.bin`,
          ),
          variant.name,
        );
      },
    );
  }

  await t.step(
    "same/single-far encodings remain identical to pristine",
    async () => {
      for (const name of ["same-segment-list", "single-far-list"]) {
        assertBytesEqual(
          await Deno.readFile(`${work}/patched/${name}.bin`),
          await Deno.readFile(`${work}/upstream/${name}.bin`),
          name,
        );
      }
    },
  );
  await t.step("native and WASI probes emit identical bytes", async () => {
    for await (const entry of Deno.readDir(`${work}/patched`)) {
      if (!entry.name.endsWith(".bin")) continue;
      assertBytesEqual(
        await Deno.readFile(`${work}/patched-wasi/${entry.name}`),
        await Deno.readFile(`${work}/patched/${entry.name}`),
        entry.name,
      );
    }
  });
});
