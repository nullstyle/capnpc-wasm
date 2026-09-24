// Unit tests for the pure Studio state module. Run from the repository root:
//   mise run test:studio-unit
import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import {
  addFile,
  beginJob,
  canReuseRequest,
  clampSplit,
  completeJob,
  createSession,
  cxxNamespace,
  deleteFile,
  editFile,
  failJob,
  goImportPath,
  goPackageName,
  invalidate,
  isJobStale,
  openWorkspace,
  renameFile,
  schemaId,
  schemaTemplate,
  selectFile,
  setEntrypoint,
  shouldAutoRun,
  tabTarget,
} from "./state.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const chat = () =>
  openWorkspace(
    new Map([
      ["README.md", bytes("notes")],
      ["chat.capnp", bytes("@0x1; struct A {}")],
      ["types/common.capnp", bytes("@0x2; struct B {}")],
      ["include/company/types.capnp", bytes("@0x3;")],
    ]),
  );

Deno.test("openWorkspace checks every schema outside include/ and shows the first", () => {
  const workspace = chat();
  deepStrictEqual([...workspace.entrypoints], [
    "chat.capnp",
    "types/common.capnp",
  ]);
  strictEqual(workspace.activeFile, "chat.capnp");
  strictEqual(workspace.revision, 0);
  strictEqual(workspace.dirty, false);
  const imported = openWorkspace(workspace.files, {
    revision: 7,
    dirty: true,
  });
  strictEqual(imported.revision, 7);
  strictEqual(imported.dirty, true);
  strictEqual(
    openWorkspace(new Map([["a.bin", bytes("")]])).activeFile,
    "a.bin",
  );
});

Deno.test("selectFile changes the shown file without a revision", () => {
  const workspace = selectFile(chat(), "README.md");
  strictEqual(workspace.activeFile, "README.md");
  strictEqual(workspace.revision, 0);
  throws(() => selectFile(workspace, "missing.capnp"), /No file/);
});

Deno.test("editFile bumps the revision and keeps other files", () => {
  const before = chat();
  const after = editFile(before, "chat.capnp", bytes("@0x1; struct C {}"));
  strictEqual(after.revision, 1);
  strictEqual(after.dirty, true);
  strictEqual(
    new TextDecoder().decode(after.files.get("chat.capnp")),
    "@0x1; struct C {}",
  );
  strictEqual(before.files.get("chat.capnp")!.length, 17);
  strictEqual(after.files.get("README.md"), before.files.get("README.md"));
  throws(() => editFile(before, "nope.capnp", bytes("")), /No file/);
});

Deno.test("addFile shows the file and checks schemas only", () => {
  const schema = addFile(chat(), "types/new.capnp", bytes("@0x4;"));
  strictEqual(schema.activeFile, "types/new.capnp");
  ok(schema.entrypoints.has("types/new.capnp"));
  strictEqual(schema.revision, 1);
  const asset = addFile(chat(), "logo.bin", bytes("x"));
  ok(!asset.entrypoints.has("logo.bin"));
  throws(() => addFile(chat(), "chat.capnp", bytes("")), /already uses/);
  throws(() => addFile(chat(), "types", bytes("")), /share the path/);
});

Deno.test("renameFile follows the shown file and its entrypoint status", () => {
  const renamed = renameFile(chat(), "chat.capnp", "proto/chat.capnp");
  strictEqual(renamed.activeFile, "proto/chat.capnp");
  ok(renamed.entrypoints.has("proto/chat.capnp"));
  ok(!renamed.entrypoints.has("chat.capnp"));
  ok(!renamed.files.has("chat.capnp"));
  const demoted = renameFile(chat(), "chat.capnp", "chat.txt");
  ok(!demoted.entrypoints.has("chat.txt"));
  const other = renameFile(chat(), "README.md", "docs/README.md");
  strictEqual(other.activeFile, "chat.capnp");
  strictEqual(renameFile(chat(), "chat.capnp", "chat.capnp").revision, 0);
  throws(() => renameFile(chat(), "chat.capnp", "README.md"), /already uses/);
  throws(() => renameFile(chat(), "nope", "x"), /No file/);
});

Deno.test("deleteFile keeps one file and moves the selection", () => {
  const after = deleteFile(chat(), "chat.capnp");
  strictEqual(after.activeFile, "README.md");
  ok(!after.entrypoints.has("chat.capnp"));
  strictEqual(after.files.size, 3);
  const other = deleteFile(chat(), "README.md");
  strictEqual(other.activeFile, "chat.capnp");
  const single = openWorkspace(new Map([["only.capnp", bytes("")]]));
  throws(() => deleteFile(single, "only.capnp"), /at least one file/);
});

Deno.test("setEntrypoint toggles schemas and ignores no-ops", () => {
  const off = setEntrypoint(chat(), "chat.capnp", false);
  ok(!off.entrypoints.has("chat.capnp"));
  strictEqual(off.revision, 1);
  strictEqual(setEntrypoint(off, "chat.capnp", false).revision, 1);
  strictEqual(setEntrypoint(off, "chat.capnp", true).revision, 2);
  throws(() => setEntrypoint(chat(), "README.md", true), /not a schema/);
});

Deno.test("results from an obsolete snapshot never apply", () => {
  let session = beginJob(createSession("cpp"), 3, ["cpp"]);
  throws(() => beginJob(session, 3, ["rust"]), /already running/);
  ok(!isJobStale(session, 3));
  ok(isJobStale(session, 4));
  const request = bytes("request");
  const stale = completeJob(session, 4, 3, request, {
    cpp: { "a.h": bytes("") },
  });
  strictEqual(stale.applied, false);
  strictEqual(stale.session.job, null);
  strictEqual(stale.session.outputs.size, 0);
  const applied = completeJob(session, 3, 3, request, {
    cpp: { "a.h": bytes("") },
  });
  strictEqual(applied.applied, true);
  session = applied.session;
  ok(canReuseRequest(session, 3));
  ok(!canReuseRequest(session, 4));
  ok(shouldAutoRun(session, 3, "rust"));
  ok(!shouldAutoRun(session, 3, "cpp"));
  ok(!shouldAutoRun(session, 4, "rust"));
  ok(!shouldAutoRun(beginJob(session, 3, ["rust"]), 3, "rust"));
  const cleared = invalidate(session);
  strictEqual(cleared.request, undefined);
  strictEqual(cleared.outputs.size, 0);
  strictEqual(cleared.language, "cpp");
});

Deno.test("a failed job drops only its targets; a cancelled one keeps output", () => {
  const request = bytes("request");
  const both = completeJob(
    beginJob(createSession("cpp"), 1, ["cpp", "rust"]),
    1,
    1,
    request,
    { cpp: { "a.h": bytes("") }, rust: { "a.rs": bytes("") } },
  ).session;
  const failed = failJob(beginJob(both, 1, ["rust"]), 1, 1, ["rust"]);
  strictEqual(failed.applied, true);
  ok(failed.session.outputs.has("cpp"));
  ok(!failed.session.outputs.has("rust"));
  const cancelled = failJob(beginJob(both, 1, ["rust"]), 1, 1, ["rust"], true);
  strictEqual(cancelled.applied, false);
  ok(cancelled.session.outputs.has("rust"));
  strictEqual(cancelled.session.job, null);
  const stale = failJob(beginJob(both, 1, ["cpp"]), 2, 1, ["cpp"]);
  strictEqual(stale.applied, false);
  ok(stale.session.outputs.has("cpp"));
});

Deno.test("tabTarget wraps for any number of tabs", () => {
  const order = ["cpp", "rust", "go", "zig", "swift"];
  strictEqual(tabTarget(order, "cpp", "ArrowLeft"), "swift");
  strictEqual(tabTarget(order, "swift", "ArrowRight"), "cpp");
  strictEqual(tabTarget(order, "go", "ArrowRight"), "zig");
  strictEqual(tabTarget(order, "go", "Home"), "cpp");
  strictEqual(tabTarget(order, "go", "End"), "swift");
  strictEqual(tabTarget(order, "go", "Enter"), undefined);
  strictEqual(tabTarget(order, "java", "ArrowRight"), undefined);
});

Deno.test("clampSplit keeps the split between 25 and 75", () => {
  strictEqual(clampSplit(10), 25);
  strictEqual(clampSplit(90), 75);
  strictEqual(clampSplit(49.6), 50);
  strictEqual(clampSplit(Number.NaN), 50);
});

Deno.test("new schema files get every annotation the generators need", () => {
  strictEqual(goPackageName("types/New-File.capnp"), "new_file");
  strictEqual(goPackageName("123.capnp"), "schema");
  strictEqual(goPackageName("chat.capnp"), "chat");
  const root = {
    path: "chat.capnp",
    text: '$Go.import("example.com/studio/chat");',
  };
  strictEqual(
    goImportPath(root, "types/x.capnp"),
    "example.com/studio/chat/types",
  );
  strictEqual(goImportPath(root, "other.capnp"), "example.com/studio/chat");
  const nested = {
    path: "types/common.capnp",
    text: '$Go.import("example.com/studio/chat/types");',
  };
  strictEqual(goImportPath(nested, "other.capnp"), "example.com/studio/chat");
  strictEqual(
    goImportPath(nested, "types/y.capnp"),
    "example.com/studio/chat/types",
  );
  strictEqual(
    goImportPath({ path: "a.capnp", text: "" }, "b/c.capnp"),
    "example.com/studio/b",
  );
  strictEqual(cxxNamespace('$Cxx.namespace("acme::proto");'), "acme::proto");
  strictEqual(cxxNamespace(""), "studio");
  strictEqual(schemaId(0, 0), "0x8000000000000000");
  strictEqual(schemaId(0xffffffff, 0xffffffff), "0xffffffffffffffff");
  const template = schemaTemplate("types/new.capnp", "0x8000000000000001", {
    path: "chat.capnp",
    text: '$Cxx.namespace("acme");\n$Go.import("example.com/acme/chat");',
  });
  ok(template.startsWith("@0x8000000000000001;\n"));
  ok(template.includes('$Cxx.namespace("acme");'));
  ok(template.includes('$Go.package("new");'));
  ok(template.includes('$Go.import("example.com/acme/chat/types");'));
  ok(template.includes("struct Example"));
});
