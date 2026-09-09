import { createEditor } from "./editor.js";
import { languages, studioCompiler } from "./compiler.js";
import { presets } from "./presets.js";
import {
  archive,
  checkPath,
  compileWorkspace,
  encoder,
  formatBytes,
  importFiles,
  isSchema,
  textOf,
  validateFiles,
} from "./workspace.js";

const $ = (selector) => document.querySelector(selector);
const runtime = studioCompiler(new URL("./assets/", import.meta.url));
let files = new Map();
let entrypoints = new Set();
let activeFile = "";
let activeLanguage = "cpp";
let selectedOutput = "";
let revision = 0;
let cachedRequest;
let requestRevision = -1;
const outputs = new Map();
let dirty = false;
let controller;
let fileMode = "add";
let noticeTimer;
let updatingEditor = false;
const editorStates = new Map();

function status(message, state = "success") {
  $("#status").textContent = message;
  $("#status-indicator").dataset.state = state;
}
function notice(message) {
  clearTimeout(noticeTimer);
  $("#notice").textContent = message;
  $("#notice").hidden = false;
  noticeTimer = setTimeout(() => $("#notice").hidden = true, 5000);
}
function badge(message, state = "") {
  $("#output-badge").textContent = message;
  $("#output-badge").dataset.state = state;
}
function diagnostics(items, error = false) {
  $("#diagnostics").dataset.error = String(error);
  $("#diagnostics").open = error;
  $("#diagnostics-title").textContent = error
    ? "Generation failed"
    : "Compiler diagnostics";
  $("#diagnostics-text").textContent = items || "No diagnostics.";
}
function busy(value) {
  $("#generate").disabled = $("#generate-all").disabled = value;
  $("#cancel").hidden = !value;
  for (const tab of document.querySelectorAll("[data-language]")) {
    tab.disabled = value;
  }
  // Workspace edits stay available during execution; revision checks below
  // prevent publishing a result for a snapshot that is no longer current.
}
function markChanged() {
  revision++;
  dirty = true;
  cachedRequest = undefined;
  requestRevision = -1;
  outputs.clear();
  diagnostics("");
  renderOutput();
  badge("Changes to generate", "stale");
  $("#timing").textContent = "";
  if (!controller) status("Workspace changed. Generate to update the output.");
}

const editor = createEditor($("#source-editor"), {
  label: "Schema source",
  onRun: () => run([activeLanguage]),
  onChange(text) {
    if (updatingEditor || !activeFile) return;
    files.set(activeFile, encoder.encode(text));
    markChanged();
    $("#source-size").textContent = formatBytes(files.get(activeFile).length);
  },
  onSelection(line, column) {
    $("#cursor-position").textContent = `Ln ${line}, Col ${column}`;
  },
});
const outputEditor = createEditor($("#output-editor"), {
  label: "Generated source",
  readonly: true,
});

function showFile(path) {
  if (activeFile && !$("#source-editor").hidden) {
    editorStates.set(activeFile, editor.state());
  }
  activeFile = path;
  const bytes = files.get(path);
  const text = textOf(bytes);
  updatingEditor = true;
  if (text !== null) {
    const state = editorStates.get(path);
    if (state && state.doc.toString() === text) editor.setState(state);
    else editor.setText(text);
  }
  updatingEditor = false;
  $("#source-editor").hidden = text === null;
  $("#binary-preview").hidden = text !== null;
  if (text === null) {
    const lines = [];
    for (let offset = 0; offset < Math.min(bytes.length, 4096); offset += 16) {
      lines.push(
        `${offset.toString(16).padStart(6, "0")}  ${
          [...bytes.slice(offset, offset + 16)].map((byte) =>
            byte.toString(16).padStart(2, "0")
          ).join(" ")
        }`,
      );
    }
    $("#binary-preview").textContent = `Binary asset · ${
      formatBytes(bytes.length)
    } · preserved unchanged\n\n${lines.join("\n")}${
      bytes.length > 4096 ? "\n\nPreview limited to 4 KiB." : ""
    }`;
  }
  $("#source-name").textContent = path;
  $("#source-name").title = path;
  $("#source-size").textContent = formatBytes(bytes.length);
  $("#source-kind").textContent = text === null
    ? "Binary asset · read only"
    : path.endsWith(".capnp")
    ? "Cap’n Proto"
    : "Text";
  const position = editor.state().selection.main.head;
  const line = editor.state().doc.lineAt(position);
  $("#cursor-position").textContent = text === null
    ? ""
    : `Ln ${line.number}, Col ${position - line.from + 1}`;
  renderFiles();
}

function renderFiles() {
  const container = $("#workspace-files");
  container.replaceChildren();
  const folders = new Set();
  for (const path of [...files.keys()].sort()) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      if (folders.has(folder)) continue;
      folders.add(folder);
      const label = document.createElement("div");
      label.className = "folder-label";
      label.style.paddingLeft = `${8 + (i - 1) * 12}px`;
      label.textContent = `⌄  ${parts[i - 1]}`;
      container.append(label);
    }
    const row = document.createElement("div");
    row.className = `file-row${path === activeFile ? " active" : ""}`;
    row.style.paddingLeft = `${(parts.length - 1) * 12}px`;
    const button = document.createElement("button");
    button.type = "button";
    button.title = path;
    button.setAttribute("aria-label", `Edit ${path}`);
    if (path === activeFile) button.setAttribute("aria-current", "page");
    const icon = document.createElement("span");
    icon.className = "file-glyph";
    icon.textContent = path.endsWith(".capnp") ? "◇" : "·";
    icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "file-label";
    label.textContent = parts.at(-1);
    button.append(icon, label);
    button.onclick = () => showFile(path);
    row.append(button);
    if (isSchema(path)) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = entrypoints.has(path);
      checkbox.title = `Generate ${path}`;
      checkbox.setAttribute("aria-label", `Generate ${path}`);
      checkbox.onchange = () => {
        if (checkbox.checked) entrypoints.add(path);
        else entrypoints.delete(path);
        markChanged();
      };
      row.append(checkbox);
    }
    container.append(row);
  }
  $("#file-count").textContent = `${files.size} file${
    files.size === 1 ? "" : "s"
  }`;
  $("#remove-file").disabled = files.size <= 1;
}

function currentEntries() {
  return outputs.get(activeLanguage) ?? {};
}
function selectedBytes() {
  return currentEntries()[selectedOutput];
}
function renderOutput() {
  const entries = currentEntries();
  const paths = Object.keys(entries).sort();
  if (!paths.includes(selectedOutput)) {
    selectedOutput = paths.find((path) => /\.(h|rs|go|zig)$/.test(path)) ??
      paths[0] ?? "";
  }
  const picker = $("#output-files");
  picker.replaceChildren();
  for (const path of paths) {
    picker.add(new Option(path, path, false, path === selectedOutput));
  }
  if (!paths.length) picker.add(new Option("No generated files", ""));
  picker.disabled =
    $("#download-file").disabled =
    $("#copy-output").disabled =
      !paths.length;
  $("#output-editor").hidden = !paths.length;
  $("#output-empty").hidden = !!paths.length;
  outputEditor.setText(
    paths.length ? new TextDecoder().decode(entries[selectedOutput]) : "",
  );
  $("#output-summary").textContent = paths.length
    ? `${paths.length} file${paths.length === 1 ? "" : "s"} · ${
      formatBytes(
        Object.values(entries).reduce((n, bytes) => n + bytes.length, 0),
      )
    }`
    : "No output yet";
  $("#download-all").disabled = outputs.size === 0;
  if (paths.length) badge("Up to date", "success");
  else {badge(
      requestRevision === revision ? "Select Generate" : "Ready to generate",
    );}
}

async function run(targets) {
  if (controller) return;
  try {
    validateFiles(files);
    if (!entrypoints.size) {
      throw new Error(
        "Check at least one schema in the workspace sidebar to generate.",
      );
    }
  } catch (error) {
    status(error.message, "error");
    diagnostics(error.message, true);
    return;
  }
  const jobRevision = revision;
  const snapshot = new Map(files);
  const selected = new Set(entrypoints);
  controller = new AbortController();
  const { signal } = controller;
  busy(true);
  diagnostics("");
  badge("Working…");
  const start = performance.now();
  let compileMs = 0;
  const reused = cachedRequest && requestRevision === revision;
  const report = (message) => {
    if (jobRevision === revision) status(message, "loading");
  };
  try {
    let request = cachedRequest;
    const reports = [];
    if (!reused) {
      const result = await runtime.compile(
        (includes) => compileWorkspace(snapshot, selected, includes),
        signal,
        report,
      );
      request = result.request;
      reports.push(...result.diagnostics);
      compileMs = performance.now() - start;
    }
    const generationStart = performance.now();
    const result = await runtime.generate(request, targets, signal, report);
    if (jobRevision !== revision) {
      status(
        "Workspace changed during generation. Generate again to use the latest files.",
      );
      badge("Changes to generate", "stale");
      return;
    }
    cachedRequest = request;
    requestRevision = revision;
    for (const [language, entries] of Object.entries(result.outputs)) {
      outputs.set(language, entries);
    }
    reports.push(...result.diagnostics);
    renderOutput();
    diagnostics(
      reports.map((item) => `[${item.stage}]\n${item.stderr}`).join("\n"),
    );
    const count = Object.values(result.outputs).reduce(
      (n, entries) => n + Object.keys(entries).length,
      0,
    );
    status(
      `Generated ${count} files for ${
        targets.map((target) => languages[target]).join(", ")
      }.`,
    );
    $("#timing").textContent = `${
      reused
        ? "Schema reused"
        : `Compile + load ${(compileMs / 1000).toFixed(2)}s`
    } · Generate + load ${
      ((performance.now() - generationStart) / 1000).toFixed(2)
    }s`;
  } catch (error) {
    if (jobRevision !== revision) {
      status(
        "Workspace changed during generation. Generate again to use the latest files.",
      );
      badge("Changes to generate", "stale");
    } else if (signal.aborted) {
      status("Cancelled. Ready when you are.");
      renderOutput();
    } else {
      // Never offer a previous successful target's bytes as this failed run.
      for (const target of targets) outputs.delete(target);
      renderOutput();
      const detail = error.diagnostics?.map((item) =>
        `[${item.stage}]\n${item.stderr}`
      ).join("\n") || error.message || String(error);
      diagnostics(detail, true);
      badge("Generation failed", "error");
      status("Generation failed. See compiler diagnostics below.", "error");
    }
  } finally {
    controller = undefined;
    busy(false);
  }
}

async function selectLanguage(language) {
  activeLanguage = language;
  for (const tab of document.querySelectorAll("[data-language]")) {
    const selected = tab.dataset.language === language;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  $("#output-content").setAttribute("aria-labelledby", `tab-${language}`);
  $("#generate-label").textContent = `Generate ${languages[language]}`;
  renderOutput();
  if (cachedRequest && requestRevision === revision && !outputs.has(language)) {
    await run([language]);
  }
}

function download(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
function confirmAction(title, description, action) {
  const dialog = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-description").textContent = description;
  $("#confirm-action").textContent = action;
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) =>
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "confirm"),
      { once: true },
    )
  );
}
async function canReplace() {
  return !dirty ||
    await confirmAction(
      "Replace workspace?",
      "This replaces your current files. Save your workspace first if you want to keep your changes.",
      "Replace workspace",
    );
}
function replaceWorkspace(next, description) {
  files = next;
  entrypoints = new Set([...files.keys()].filter(isSchema));
  editorStates.clear();
  activeFile = "";
  markChanged();
  showFile([...files.keys()].find(isSchema) ?? files.keys().next().value);
  $("#example-description").textContent = description;
  diagnostics("");
}
function loadPreset(preset) {
  replaceWorkspace(
    new Map(
      Object.entries(preset.files).map((
        [path, text],
      ) => [path, encoder.encode(text)]),
    ),
    preset.description,
  );
  dirty = false;
}

for (const preset of presets) {
  $("#examples").add(new Option(preset.name, preset.id));
}
$("#examples").add(new Option("Custom workspace", "custom"));
let currentExample = presets[0].id;
$("#examples").onchange = async () => {
  const id = $("#examples").value;
  if (id === "custom") {
    $("#examples").value = currentExample;
    return;
  }
  if (!await canReplace()) {
    $("#examples").value = currentExample;
    return;
  }
  currentExample = id;
  loadPreset(presets.find((preset) => preset.id === id));
  status("Example loaded. Generate to explore its output.");
};
async function openFiles(input, directory) {
  try {
    const next = await importFiles(input.files, directory);
    if (!next || !await canReplace()) return;
    replaceWorkspace(
      next,
      "Imported workspace. Binary assets are kept unchanged.",
    );
    currentExample = "custom";
    $("#examples").value = "custom";
    status("Workspace imported. Select a language and generate.");
  } catch (error) {
    notice(error.message);
  } finally {
    input.value = "";
  }
}
$("#import-files").onclick = () => $("#files-input").click();
$("#import-folder").onclick = () => $("#folder-input").click();
$("#files-input").onchange = () => openFiles($("#files-input"), false);
$("#folder-input").onchange = () => openFiles($("#folder-input"), true);
$("#generate").onclick = () => run([activeLanguage]);
$("#generate-all").onclick = () => run(Object.keys(languages));
$("#cancel").onclick = () => controller?.abort();
for (const tab of document.querySelectorAll("[data-language]")) {
  tab.onclick = () => selectLanguage(tab.dataset.language);
  tab.onkeydown = (event) => {
    const keys = Object.keys(languages);
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const i = keys.indexOf(activeLanguage);
    const target = event.key === "Home"
      ? keys[0]
      : event.key === "End"
      ? keys.at(-1)
      : keys[(i + (event.key === "ArrowRight" ? 1 : 3)) % 4];
    $(`#tab-${target}`).focus();
    selectLanguage(target);
  };
}
$("#output-files").onchange = () => {
  selectedOutput = $("#output-files").value;
  renderOutput();
};
$("#download-file").onclick = () => {
  if (selectedBytes()) {
    download(selectedBytes(), selectedOutput.split("/").at(-1), "text/plain");
  }
};
$("#download-all").onclick = () => {
  const all = new Map();
  for (const [language, entries] of outputs) {
    for (const [path, bytes] of Object.entries(entries)) {
      all.set(`${language}/${path}`, bytes);
    }
  }
  if (all.size) download(archive(all), "outputs.zip", "application/zip");
};
$("#download-workspace").onclick = () => {
  download(archive(files), "schema-workspace.zip", "application/zip");
  notice(
    "Workspace download started. The ZIP preserves folders and binary assets.",
  );
};
$("#copy-output").onclick = async () => {
  try {
    await navigator.clipboard.writeText(outputEditor.text());
    notice("Generated source copied.");
  } catch {
    notice(
      "Clipboard access was denied. Select the code to copy it, or download the file.",
    );
  }
};
function openFileDialog(mode) {
  fileMode = mode;
  $("#file-dialog-title").textContent = mode === "add"
    ? "New file"
    : "Rename file";
  $("#file-submit").textContent = mode === "add" ? "Create file" : "Rename";
  $("#file-path").value = mode === "add" ? "" : activeFile;
  $("#file-error").textContent = "";
  $("#file-dialog").showModal();
  $("#file-path").focus();
}
$("#add-file").onclick = () => openFileDialog("add");
$("#rename-file").onclick = () => openFileDialog("rename");
for (const button of document.querySelectorAll(".close-dialog")) {
  button.onclick = () => $("#file-dialog").close();
}
$("#file-form").onsubmit = (event) => {
  event.preventDefault();
  try {
    const path = checkPath($("#file-path").value.trim());
    if (files.has(path) && !(fileMode === "rename" && path === activeFile)) {
      throw new Error("A file already uses this path.");
    }
    const next = new Map(files);
    let bytes;
    if (fileMode === "rename") {
      bytes = files.get(activeFile);
      next.delete(activeFile);
    } else {
      const words = crypto.getRandomValues(new Uint32Array(2));
      const id = (BigInt(words[0]) << 32n | BigInt(words[1]) | (1n << 63n))
        .toString(16);
      bytes = encoder.encode(
        path.endsWith(".capnp")
          ? `@0x${id};\n\nstruct Example {\n  value @0 :Text;\n}\n`
          : "",
      );
    }
    next.set(path, bytes);
    validateFiles(next);
    const wasEntry = fileMode === "rename" && entrypoints.has(activeFile);
    if (fileMode === "rename") {
      entrypoints.delete(activeFile);
      editorStates.delete(activeFile);
    }
    files = next;
    if (isSchema(path) && (fileMode === "add" || wasEntry)) {
      entrypoints.add(path);
    }
    activeFile = "";
    markChanged();
    showFile(path);
    $("#file-dialog").close();
    if (fileMode === "rename") {
      notice("File renamed. Update any imports that refer to its old path.");
    }
    editor.focus();
  } catch (error) {
    $("#file-error").textContent = error.message;
  }
};
$("#remove-file").onclick = async () => {
  const path = activeFile;
  if (
    files.size <= 1 ||
    !await confirmAction(
      "Delete file?",
      `Delete ${path} from this workspace? Imports that reference it will need to be updated.`,
      "Delete file",
    )
  ) return;
  files.delete(path);
  entrypoints.delete(path);
  editorStates.delete(path);
  activeFile = "";
  markChanged();
  showFile(files.keys().next().value);
};

const handle = $("#resize");
function resize(percent) {
  percent = Math.max(25, Math.min(75, percent));
  $("#workbench").style.gridTemplateColumns = `${
    $(".workspace-panel").getBoundingClientRect().width
  }px minmax(0,${percent}fr) 5px minmax(0,${100 - percent}fr)`;
  handle.setAttribute("aria-valuenow", String(Math.round(percent)));
}
handle.onpointerdown = (event) => {
  handle.setPointerCapture(event.pointerId);
  handle.onpointermove = (move) => {
    const box = $("#workbench").getBoundingClientRect();
    const sidebar = $(".workspace-panel").getBoundingClientRect().width;
    resize(
      (move.clientX - box.left - sidebar) / (box.width - sidebar - 5) * 100,
    );
  };
  handle.onpointerup = handle.onpointercancel = () => {
    handle.onpointermove = null;
  };
};
handle.onkeydown = (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  resize(
    Number(handle.getAttribute("aria-valuenow")) +
      (event.key === "ArrowRight" ? 5 : -5),
  );
};
addEventListener("beforeunload", (event) => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});
addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  controller?.abort();
  runtime.dispose();
  editor.destroy();
  outputEditor.destroy();
}, { once: true });
if (!navigator.platform.includes("Mac")) $("#shortcut").textContent = "Ctrl ↵";
loadPreset(presets[0]);
busy(false);
await run([activeLanguage]);
