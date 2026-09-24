// Unit tests for the workspace helpers: paths, limits, imports, and archives.
// Run from the repository root with `mise run test:studio-unit`.
import {
  deepStrictEqual,
  ok,
  rejects,
  strictEqual,
  throws,
} from "node:assert/strict";
import { zipSync } from "fflate";
import {
  archive,
  checkPath,
  compileWorkspace,
  countNodes,
  formatBytes,
  importFiles,
  isHidden,
  isSchema,
  limits,
  textOf,
  unzipArchive,
  validateFiles,
} from "./workspace.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

/** The subset of File that importFiles reads. */
function pick(
  name: string,
  contents: Uint8Array,
  relative = name,
): {
  name: string;
  size: number;
  webkitRelativePath: string;
  arrayBuffer(): Promise<ArrayBuffer>;
} {
  return {
    name,
    size: contents.length,
    webkitRelativePath: relative,
    arrayBuffer: () =>
      Promise.resolve(
        contents.buffer.slice(
          contents.byteOffset,
          contents.byteOffset + contents.length,
        ) as ArrayBuffer,
      ),
  };
}

Deno.test("checkPath accepts canonical relative paths only", () => {
  strictEqual(checkPath("types/common.capnp"), "types/common.capnp");
  for (
    const bad of [
      "",
      "..",
      "a/../b",
      "/abs.capnp",
      "a\\b",
      "a/./b",
      "a//b",
      "tab\t.capnp",
      "x".repeat(limits.pathLength + 1),
      "\ud800.capnp",
    ]
  ) throws(() => checkPath(bad), /relative path/, bad);
});

Deno.test("isHidden matches dot-prefixed segments and __MACOSX", () => {
  for (const hidden of [".git/HEAD", ".DS_Store", "a/.b/c", "__MACOSX/x"]) {
    ok(isHidden(hidden), hidden);
  }
  for (const shown of ["a.b/c", "types/common.capnp", "x/y.z"]) {
    ok(!isHidden(shown), shown);
  }
});

Deno.test("countNodes counts files and the folders they imply", () => {
  strictEqual(countNodes(["a/b/c.capnp", "a/b/d.capnp", "e.capnp"]), 5);
  strictEqual(countNodes([]), 0);
});

Deno.test("validateFiles names the budget that was exceeded", () => {
  const many = new Map<string, Uint8Array>();
  for (let i = 0; i < limits.entries + 1; i++) {
    many.set(`f${i}.capnp`, bytes(""));
  }
  throws(() => validateFiles(many), /up to 128 files; this one has 129/);
  const big = new Map([["big.bin", new Uint8Array(limits.bytes + 1)]]);
  throws(() => validateFiles(big), /up to 8.0 MiB; this one has/);
  const deep = new Map<string, Uint8Array>();
  for (let i = 0; i < limits.entries; i++) {
    deep.set(`a${i}/b/c/d/e.capnp`, bytes(""));
  }
  throws(
    () => validateFiles(deep),
    /files and folders combined; this one has 640/,
  );
  // 128 files with four nodes each meet the 512-node budget exactly.
  const wide = new Map<string, Uint8Array>();
  for (let i = 0; i < limits.entries; i++) {
    wide.set(`a${i}/b/c/e.capnp`, bytes(""));
  }
  validateFiles(wide);
  throws(
    () =>
      validateFiles(
        new Map([["types", bytes("")], ["types/a.capnp", bytes("")]]),
      ),
    /share the path types/,
  );
  throws(() => validateFiles(new Map()), /at least one file/);
});

Deno.test("textOf treats control bytes and invalid UTF-8 as binary", () => {
  strictEqual(textOf(bytes("struct A {}\n\t")), "struct A {}\n\t");
  strictEqual(textOf(new Uint8Array([0, 255, 4, 128])), null);
  strictEqual(textOf(new Uint8Array([0xff, 0xfe])), null);
  strictEqual(isSchema("a.capnp"), true);
  strictEqual(isSchema("include/a.capnp"), false);
  strictEqual(isSchema("a.txt"), false);
});

Deno.test("compileWorkspace splits include/ from sources and sorts entrypoints", () => {
  const request = compileWorkspace(
    new Map([
      ["b.capnp", bytes("b")],
      ["a.capnp", bytes("a")],
      ["include/company/t.capnp", bytes("t")],
    ]),
    new Set(["b.capnp", "a.capnp"]),
    { "go.capnp": bytes("go") },
  );
  deepStrictEqual(Object.keys(request.files), ["b.capnp", "a.capnp"]);
  deepStrictEqual(Object.keys(request.includeFiles), [
    "go.capnp",
    "company/t.capnp",
  ]);
  deepStrictEqual(request.entrypoints, ["a.capnp", "b.capnp"]);
  deepStrictEqual(request.generators, []);
  throws(
    () => compileWorkspace(new Map([["a.capnp", bytes("")]]), new Set(), {}),
    /at least one schema/,
  );
});

Deno.test("importFiles skips hidden entries, counts them, and names the limits", async () => {
  const result = await importFiles([
    pick("a.capnp", bytes("@0x1;"), "project/a.capnp"),
    pick("HEAD", bytes("ref"), "project/.git/HEAD"),
    pick(".DS_Store", bytes("\0"), "project/.DS_Store"),
    pick("b.capnp", bytes("@0x2;"), "project/types/b.capnp"),
  ], true);
  ok(result);
  deepStrictEqual([...result.files.keys()], ["a.capnp", "types/b.capnp"]);
  strictEqual(result.hidden, 2);
  strictEqual(result.archives, 0);
  await rejects(
    () => importFiles([pick(".DS_Store", bytes(""))]),
    /all 1 selected files are hidden/,
  );
  const many = Array.from(
    { length: limits.entries + 1 },
    (_, i) => pick(`f${i}.capnp`, bytes("")),
  );
  await rejects(() => importFiles(many), /129 were selected/);
  await rejects(
    () =>
      importFiles([
        pick("big.bin", new Uint8Array(limits.bytes)),
        pick("more.bin", new Uint8Array(1)),
      ]),
    /totaling at most 8.0 MiB; 8.0 MiB were selected/,
  );
  await rejects(
    () =>
      importFiles([pick("a.capnp", bytes("1")), pick("a.capnp", bytes("2"))]),
    /More than one file is named a.capnp/,
  );
  strictEqual(await importFiles([]), null);
});

Deno.test("importFiles expands a ZIP in flat mode and keeps it in folder mode", async () => {
  const zip = zipSync({
    "schema-workspace/chat.capnp": bytes("@0x1;"),
    "schema-workspace/types/common.capnp": bytes("@0x2;"),
    "schema-workspace/asset.bin": new Uint8Array([0, 255, 4, 128]),
    "schema-workspace/.DS_Store": bytes("x"),
  });
  const flat = await importFiles([pick("schema-workspace.zip", zip)]);
  ok(flat);
  deepStrictEqual([...flat.files.keys()].sort(), [
    "asset.bin",
    "chat.capnp",
    "types/common.capnp",
  ]);
  deepStrictEqual([...flat.files.get("asset.bin")!], [0, 255, 4, 128]);
  strictEqual(flat.archives, 1);
  strictEqual(flat.hidden, 1);
  const folder = await importFiles([
    pick("schema-workspace.zip", zip, "project/schema-workspace.zip"),
  ], true);
  ok(folder);
  deepStrictEqual([...folder.files.keys()], ["schema-workspace.zip"]);
  strictEqual(folder.archives, 0);
});

Deno.test("unzipArchive guards declared sizes and entry counts before inflating", () => {
  const big = zipSync({ "big.bin": new Uint8Array(limits.bytes + 1) });
  throws(() => unzipArchive(big), /expands to more than 8.0 MiB/);
  const entries: Record<string, Uint8Array> = {};
  for (let i = 0; i < limits.entries + 1; i++) entries[`f${i}`] = bytes("");
  throws(() => unzipArchive(zipSync(entries)), /more than 128 files/);
  throws(
    () => unzipArchive(zipSync({ "../escape.capnp": bytes("") })),
    /not a relative path/,
  );
  throws(
    () => unzipArchive(bytes("not a zip archive at all")),
    /could not be read/,
  );
  const mixed = unzipArchive(zipSync({
    "top/": new Uint8Array(0),
    "top/a.capnp": bytes("a"),
    "top/__MACOSX/._a.capnp": bytes("junk"),
    "top/sub/b.capnp": bytes("b"),
  }));
  deepStrictEqual([...mixed.files.keys()], ["a.capnp", "sub/b.capnp"]);
  strictEqual(mixed.hidden, 1);
  const noTop = unzipArchive(
    zipSync({ "a.capnp": bytes("a"), "b/c.capnp": bytes("c") }),
  );
  deepStrictEqual([...noTop.files.keys()], ["a.capnp", "b/c.capnp"]);
});

Deno.test("archive and unzipArchive round-trip folders and binary bytes", () => {
  const files = new Map([
    ["chat.capnp", bytes("@0x1;")],
    ["types/common.capnp", bytes("@0x2;")],
    ["asset.bin", new Uint8Array([0, 255, 4, 128])],
  ]);
  const restored = unzipArchive(archive(files));
  strictEqual(restored.hidden, 0);
  deepStrictEqual([...restored.files.keys()].sort(), [...files.keys()].sort());
  for (const [path, contents] of files) {
    deepStrictEqual([...restored.files.get(path)!], [...contents]);
  }
  strictEqual(text(restored.files.get("chat.capnp")!), "@0x1;");
});

Deno.test("formatBytes picks a unit", () => {
  strictEqual(formatBytes(512), "512 B");
  strictEqual(formatBytes(1536), "1.5 KiB");
  strictEqual(formatBytes(8 * 1024 * 1024), "8.0 MiB");
});
