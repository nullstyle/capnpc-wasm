// View bindings for Schema Studio. Workspace and job rules live in state.js;
// this module renders them and wires the DOM, the editors, and the runtime.
import { createEditor } from "./editor.js";
import {
  assetVersion,
  languages,
  studioCompiler,
  supportsWasmExceptions,
} from "./compiler.js";
import { presets } from "./presets.js";
import {
  archive,
  checkPath,
  compileWorkspace,
  encoder,
  formatBytes,
  importFiles,
  isSchema,
  limits,
  textOf,
  validateFiles,
} from "./workspace.js";
import * as state from "./state.js";

const $ = (selector) => document.querySelector(selector);
const languageOrder = Object.keys(languages);
const runtime = studioCompiler(new URL("./assets/", import.meta.url));
const restart = new DOMException(
  "Restarted with the latest edits",
  "AbortError",
);

let workspace = state.openWorkspace(new Map());
let session = state.createSession("cpp");
let selectedOutput = "";
/** The running job's controller and completion, if any. */
let job;
let supported = true;
let fileMode = "add";
let noticeTimer;
let updatingEditor = false;
const editorStates = new Map();

function status(message, tone = "success") {
  $("#status").textContent = message;
  $("#status-indicator").dataset.state = tone;
}
function notice(message) {
  clearTimeout(noticeTimer);
  $("#notice").textContent = message;
  noticeTimer = setTimeout(() => $("#notice").textContent = "", 5000);
}
// Errors stay until dismissed; the region is always rendered so they are
// announced.
function alert(message) {
  const dismiss = $("#alert-dismiss");
  // Hiding the focused Dismiss button would drop focus to the body.
  if (!message && document.activeElement === dismiss) $("#generate").focus();
  $("#alert").textContent = message;
  $("#alert-bar").dataset.open = String(Boolean(message));
  dismiss.hidden = !message;
}
function badge(message, tone = "") {
  $("#output-badge").textContent = message;
  $("#output-badge").dataset.state = tone;
}
function diagnostics(items, error = false, header = "") {
  $("#diagnostics").dataset.error = String(error);
  $("#diagnostics").open = error;
  $("#diagnostics-title").textContent = error
    ? "Generation failed"
    : "Compiler diagnostics";
  $("#diagnostics-error").textContent = header;
  $("#diagnostics-error").hidden = !header;
  $("#diagnostics-text").textContent = items || "No diagnostics.";
}
function setEnabled(element, enabled) {
  element.setAttribute("aria-disabled", String(!enabled));
}
// Controls stay focusable while a job runs: aria-disabled plus handler guards
// replace the disabled attribute, so keyboard focus never drops to the body.
function renderControls() {
  const running = session.job !== null;
  const stale = state.isJobStale(session, workspace.revision);
  const canGenerate = supported && (!running || stale);
  setEnabled($("#generate"), canGenerate);
  setEnabled($("#generate-all"), canGenerate);
  const cancel = $("#cancel");
  if (!running && document.activeElement === cancel) $("#generate").focus();
  cancel.hidden = !running;
  document.body.dataset.busy = String(running);
}
/** Scroll a result or error into view where the layout stacks vertically. */
function reveal(selector) {
  if (!matchMedia("(max-width: 820px)").matches) return;
  $(selector).scrollIntoView({
    block: "start",
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
  });
}

/**
 * Apply a workspace transition that changed content or entrypoints. Status is
 * announced on transitions only: once when current output becomes stale, and
 * once when edits arrive during a run that can now be restarted.
 */
function changed(next) {
  const hadRequest = state.canReuseRequest(session, workspace.revision);
  const wasStale = state.isJobStale(session, workspace.revision);
  workspace = next;
  session = state.invalidate(session);
  diagnostics("");
  renderOutput();
  badge("Changes to generate", "stale");
  $("#timing").textContent = "";
  if (session.job) {
    if (!wasStale) {
      status("Workspace changed. Generate to restart with the latest edits.");
    }
  } else if (hadRequest) {
    status("Workspace changed. Generate to update the output.");
  }
  renderControls();
}

const editor = createEditor($("#source-editor"), {
  label: "Schema source",
  onRun: () => run([session.language]),
  onChange(text) {
    if (updatingEditor || !workspace.activeFile) return;
    const bytes = encoder.encode(text);
    changed(state.editFile(workspace, workspace.activeFile, bytes));
    $("#source-size").textContent = formatBytes(bytes.length);
  },
  onSelection(line, column) {
    $("#cursor-position").textContent = `Ln ${line}, Col ${column}`;
  },
});
const outputEditor = createEditor($("#output-editor"), {
  label: "Generated source",
  readonly: true,
});

/** Keep the shown file's undo history and cursor before the editor changes. */
function saveEditorState() {
  const path = workspace.activeFile;
  if (path && workspace.files.has(path) && !$("#source-editor").hidden) {
    editorStates.set(path, editor.state());
  }
}

function renderActiveFile() {
  const path = workspace.activeFile;
  const bytes = workspace.files.get(path);
  const text = textOf(bytes);
  updatingEditor = true;
  if (text !== null) {
    const saved = editorStates.get(path);
    if (saved && saved.doc.toString() === text) editor.setState(saved);
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

function showFile(path) {
  if (path === workspace.activeFile) return;
  // renderFiles() rebuilds the file buttons; keep focus on the chosen one.
  const refocus = document.activeElement?.closest("#workspace-files") != null;
  saveEditorState();
  workspace = state.selectFile(workspace, path);
  renderActiveFile();
  if (refocus) $('#workspace-files [aria-current="true"]')?.focus();
}

function renderFiles() {
  const container = $("#workspace-files");
  container.replaceChildren();
  const folders = new Set();
  for (const path of [...workspace.files.keys()].sort()) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      if (folders.has(folder)) continue;
      folders.add(folder);
      const label = document.createElement("div");
      label.className = "folder-label";
      label.style.paddingLeft = `${8 + (i - 1) * 12}px`;
      const caret = document.createElement("span");
      caret.textContent = "⌄";
      caret.setAttribute("aria-hidden", "true");
      label.append(caret, parts[i - 1]);
      container.append(label);
    }
    const active = path === workspace.activeFile;
    const row = document.createElement("div");
    row.className = `file-row${active ? " active" : ""}`;
    row.style.paddingLeft = `${(parts.length - 1) * 12}px`;
    const button = document.createElement("button");
    button.type = "button";
    button.title = path;
    button.setAttribute("aria-label", `Edit ${path}`);
    if (active) button.setAttribute("aria-current", "true");
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
      const toggle = document.createElement("label");
      toggle.className = "entry-toggle";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = workspace.entrypoints.has(path);
      checkbox.title = `Generate ${path}`;
      checkbox.setAttribute("aria-label", `Generate ${path}`);
      checkbox.onchange = () => {
        changed(state.setEntrypoint(workspace, path, checkbox.checked));
      };
      toggle.append(checkbox);
      row.append(toggle);
    }
    container.append(row);
  }
  $("#file-count").textContent = `${workspace.files.size} file${
    workspace.files.size === 1 ? "" : "s"
  }`;
  $("#remove-file").disabled = workspace.files.size <= 1;
}

function currentEntries() {
  return session.outputs.get(session.language) ?? {};
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
  $("#download-all").disabled = session.outputs.size === 0;
  if (paths.length) badge("Up to date", "success");
  else if (session.job) badge("Working…");
  else {
    badge(
      state.canReuseRequest(session, workspace.revision)
        ? "Select Generate"
        : "Ready to generate",
    );
  }
}

/**
 * Explain a failed job. The SDK's message names the kind (exit, trap, or
 * budget) and the stage; the diagnostics keep the guest's raw stderr,
 * including the compile stage when generation failed later.
 */
function describeFailure(error, reports) {
  const blocks = [...reports, ...(error?.diagnostics ?? [])];
  let detail = blocks.map((item) => `[${item.stage}]\n${item.stderr}`).join(
    "\n",
  );
  let title;
  if (error?.name === "CompileError") {
    title = error.message;
    const limit = /(\w+) resource limit exceeded/.exec(error.message)?.[1];
    if (limit === "stderrBytes") {
      detail += "\n\n[diagnostics cut off: stderr exceeded the 1 MiB limit]";
    } else if (limit) {
      title += ` (the ${limit} budget bounds every generated file set)`;
    }
  } else if (error?.name === "TimeoutError") {
    title =
      "Generation timed out after 30 seconds. Try again, or simplify the schema.";
  } else if (error instanceof TypeError) {
    const budget = /exceeds (\w+) limit/.exec(error.message)?.[1];
    const advice = {
      workspaceBytes: `Keep the workspace under ${
        formatBytes(limits.bytes)
      } of files.`,
      workspaceEntries:
        `Keep the workspace under ${limits.nodes} files and folders combined.`,
      pathBytes: "Shorten the file paths.",
      requestBytes:
        "The compiled schema is larger than the 64 MiB request limit.",
    }[budget];
    title = advice
      ? `The workspace is too large to compile: ${advice}`
      : `Studio could not build a valid request: ${error.message}`;
  } else title = error?.message || String(error);
  return { title, detail };
}

function staleFinished() {
  status(
    "Workspace changed during generation. Generate again to use the latest files.",
  );
  badge("Changes to generate", "stale");
}

async function execute(revision, snapshot, selected, targets, signal) {
  renderControls();
  diagnostics("");
  badge("Working…");
  const start = performance.now();
  let compileMs = 0;
  const reused = state.canReuseRequest(session, revision);
  const report = (message) => {
    if (revision === workspace.revision) status(message, "loading");
  };
  const reports = [];
  try {
    let request = session.request;
    if (!reused) {
      const result = await runtime.compile(
        (includes) => compileWorkspace(snapshot, selected, includes),
        targets,
        signal,
        report,
      );
      request = result.request;
      reports.push(...result.diagnostics);
      compileMs = performance.now() - start;
    }
    const generationStart = performance.now();
    const result = await runtime.generate(request, targets, signal, report);
    reports.push(...result.diagnostics);
    const outcome = state.completeJob(
      session,
      workspace.revision,
      revision,
      request,
      result.outputs,
    );
    session = outcome.session;
    if (!outcome.applied) {
      staleFinished();
      return;
    }
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
    reveal("#output-content");
  } catch (error) {
    const cancelled = signal.aborted;
    const outcome = state.failJob(
      session,
      workspace.revision,
      revision,
      targets,
      cancelled,
    );
    session = outcome.session;
    if (signal.reason === restart) {
      // The restarting run reports its own progress.
    } else if (cancelled) {
      status("Cancelled. Ready when you are.");
      renderOutput();
    } else if (!outcome.applied) {
      staleFinished();
    } else {
      // Never offer a previous successful target's bytes as this failed run.
      renderOutput();
      const failure = describeFailure(error, reports);
      diagnostics(failure.detail, true, failure.title);
      badge("Generation failed", "error");
      status("Generation failed. See the diagnostics below.", "error");
      reveal("#diagnostics");
    }
  } finally {
    renderControls();
  }
}

/**
 * Start a job for the current snapshot. A running job for the same snapshot
 * is left alone; one for an older snapshot is stopped first, so Generate and
 * Mod-Enter restart with the latest edits instead of waiting.
 */
async function run(targets) {
  if (!supported) return;
  if (job) {
    if (!state.isJobStale(session, workspace.revision)) return;
    job.controller.abort(restart);
    await job.done;
  }
  try {
    validateFiles(workspace.files);
    if (!workspace.entrypoints.size) {
      throw new Error(
        "Check at least one schema in the workspace sidebar to generate.",
      );
    }
  } catch (error) {
    status(error.message, "error");
    diagnostics("", true, error.message);
    return;
  }
  const revision = workspace.revision;
  const controller = new AbortController();
  session = state.beginJob(session, revision, targets);
  const current = { controller, done: undefined };
  job = current;
  current.done = execute(
    revision,
    new Map(workspace.files),
    new Set(workspace.entrypoints),
    targets,
    controller.signal,
  ).finally(() => {
    if (job === current) job = undefined;
  });
  await current.done;
}

function renderTabs() {
  for (const tab of document.querySelectorAll("[data-language]")) {
    const selected = tab.dataset.language === session.language;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  $("#output-content").setAttribute(
    "aria-labelledby",
    `tab-${session.language}`,
  );
  $("#generate-label").textContent = `Generate ${languages[session.language]}`;
}
async function selectLanguage(language) {
  session = { ...session, language };
  renderTabs();
  renderOutput();
  if (state.shouldAutoRun(session, workspace.revision, language)) {
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
  return !workspace.dirty ||
    await confirmAction(
      "Replace workspace?",
      "This replaces your current files. Save your workspace first if you want to keep your changes.",
      "Replace workspace",
    );
}
function replaceWorkspace(files, description, dirty) {
  editorStates.clear();
  changed(
    state.openWorkspace(files, { revision: workspace.revision + 1, dirty }),
  );
  renderActiveFile();
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
    false,
  );
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
    const imported = await importFiles(input.files, directory);
    if (!imported || !await canReplace()) return;
    alert("");
    replaceWorkspace(
      imported.files,
      "Imported workspace. Binary assets are kept unchanged.",
      true,
    );
    currentExample = "custom";
    $("#examples").value = "custom";
    const count = imported.files.size;
    status(
      `Imported ${count} file${count === 1 ? "" : "s"}${
        imported.archives
          ? ` from ${imported.archives} archive${
            imported.archives === 1 ? "" : "s"
          }`
          : ""
      }${
        imported.hidden
          ? `, skipped ${imported.hidden} hidden file${
            imported.hidden === 1 ? "" : "s"
          }`
          : ""
      }. Select a language and generate.`,
    );
  } catch (error) {
    alert(`Import failed. ${error.message}`);
  } finally {
    input.value = "";
  }
}
$("#alert-dismiss").onclick = () => alert("");
$("#import-files").onclick = () => $("#files-input").click();
$("#import-folder").onclick = () => $("#folder-input").click();
$("#files-input").onchange = () => openFiles($("#files-input"), false);
$("#folder-input").onchange = () => openFiles($("#folder-input"), true);
$("#generate").onclick = () => run([session.language]);
$("#generate-all").onclick = () => run(languageOrder);
$("#cancel").onclick = () => job?.controller.abort();

// Tabs come from the language list. Activation is manual: arrows, Home and
// End move focus only, and Enter, Space or a click select the language.
const tablist = $("#language-tabs");
for (const language of languageOrder) {
  const tab = document.createElement("button");
  tab.type = "button";
  tab.id = `tab-${language}`;
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-selected", "false");
  tab.setAttribute("aria-controls", "output-content");
  tab.tabIndex = -1;
  tab.dataset.language = language;
  tab.textContent = languages[language];
  tab.onclick = () => selectLanguage(language);
  tab.onfocus = () => {
    for (const other of tablist.children) {
      other.tabIndex = other === tab ? 0 : -1;
    }
  };
  tab.onkeydown = (event) => {
    const target = state.tabTarget(languageOrder, language, event.key);
    if (!target) return;
    event.preventDefault();
    $(`#tab-${target}`).focus();
  };
  tablist.append(tab);
}
// Arrowing parks the tab order on the focused tab; once focus leaves the
// tablist, only the selected tab stays in it (the APG tabs pattern), so
// Shift+Tab and Tab re-enter on the selection. Only tabindex changes here:
// this runs during the mousedown of whatever took focus, and replacing DOM
// inside that control (as renderTabs() does to the Generate label) makes
// WebKit drop the click.
tablist.addEventListener("focusout", (event) => {
  if (tablist.contains(event.relatedTarget)) return;
  for (const tab of tablist.children) {
    tab.tabIndex = tab.dataset.language === session.language ? 0 : -1;
  }
});
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
  for (const [language, entries] of session.outputs) {
    for (const [path, bytes] of Object.entries(entries)) {
      all.set(`${language}/${path}`, bytes);
    }
  }
  if (all.size) download(archive(all), "outputs.zip", "application/zip");
};
$("#download-workspace").onclick = () => {
  download(archive(workspace.files), "schema-workspace.zip", "application/zip");
  notice(
    "Workspace download started. The ZIP preserves folders and binary assets, and Import files opens it again.",
  );
};
$("#copy-output").onclick = async () => {
  try {
    await navigator.clipboard.writeText(outputEditor.text());
    notice("Generated source copied.");
  } catch {
    alert(
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
  $("#file-path").value = mode === "add" ? "" : workspace.activeFile;
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
    let next;
    if (fileMode === "rename") {
      const from = workspace.activeFile;
      next = state.renameFile(workspace, from, path);
      if (editorStates.has(from)) {
        editorStates.set(path, editorStates.get(from));
        editorStates.delete(from);
      }
    } else {
      const words = crypto.getRandomValues(new Uint32Array(2));
      const reference = {
        path: workspace.activeFile,
        text: textOf(workspace.files.get(workspace.activeFile)) ?? "",
      };
      next = state.addFile(
        workspace,
        path,
        encoder.encode(
          isSchema(path) || path.endsWith(".capnp")
            ? state.schemaTemplate(
              path,
              state.schemaId(words[0], words[1]),
              reference,
            )
            : "",
        ),
      );
    }
    saveEditorState();
    changed(next);
    renderActiveFile();
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
  const path = workspace.activeFile;
  if (
    workspace.files.size <= 1 ||
    !await confirmAction(
      "Delete file?",
      `Delete ${path} from this workspace? Imports that reference it will need to be updated.`,
      "Delete file",
    )
  ) return;
  editorStates.delete(path);
  changed(state.deleteFile(workspace, path));
  renderActiveFile();
  $("#source-panel").focus();
};

// The split is stored as a percentage in custom properties; the sidebar
// column stays with the stylesheet's breakpoints.
const handle = $("#resize");
function resize(percent) {
  const split = state.clampSplit(percent);
  $("#workbench").style.setProperty("--source-share", `${split}fr`);
  $("#workbench").style.setProperty("--output-share", `${100 - split}fr`);
  handle.setAttribute("aria-valuenow", String(split));
}
handle.onpointerdown = (event) => {
  handle.setPointerCapture(event.pointerId);
  handle.onpointermove = (move) => {
    const box = $("#workbench").getBoundingClientRect();
    const sidebar = $(".workspace-panel").getBoundingClientRect().width;
    const width = handle.getBoundingClientRect().width;
    resize(
      (move.clientX - box.left - sidebar) / (box.width - sidebar - width) *
        100,
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
  if (workspace.dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});
addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  job?.controller.abort();
  runtime.dispose();
  editor.destroy();
  outputEditor.destroy();
}, { once: true });
if (!navigator.platform.includes("Mac")) $("#shortcut").textContent = "Ctrl ↵";
$("#build-version").textContent = `Build ${assetVersion.slice(0, 12)}`;
loadPreset(presets[0]);
renderTabs();
if (supportsWasmExceptions()) {
  renderControls();
  await run([session.language]);
} else {
  supported = false;
  renderControls();
  alert(
    "This browser cannot run Schema Studio: it lacks standardized WebAssembly exception handling (exnref), which the Cap’n Proto compiler needs. Use Chrome 137, Firefox 131, Safari 18.4, or newer.",
  );
  status("Unsupported browser. Generation is unavailable here.", "error");
  badge("Unavailable", "error");
}
