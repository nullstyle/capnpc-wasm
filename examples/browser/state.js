// @ts-check
// Pure workspace and session state for Schema Studio. Every transition returns
// a new value and touches no DOM, so main.js stays a view binding and these
// rules run under `deno test` without a browser.
import { isSchema, validateFiles } from "./workspace.js";

/**
 * @typedef {object} Workspace
 * @property {ReadonlyMap<string, Uint8Array>} files Path to contents.
 * @property {ReadonlySet<string>} entrypoints Checked schemas that receive output.
 * @property {string} activeFile The file shown in the editor.
 * @property {number} revision Increments on every content or entrypoint change.
 * @property {boolean} dirty Edits exist since the workspace was opened.
 */

/**
 * @typedef {object} Job
 * @property {number} revision The workspace revision the job compiles.
 * @property {readonly string[]} targets Languages the job generates.
 */

/**
 * @typedef {object} Session
 * @property {Uint8Array | undefined} request The cached compiler request.
 * @property {number} requestRevision Revision `request` was compiled from, or -1.
 * @property {ReadonlyMap<string, Readonly<Record<string, Uint8Array>>>} outputs
 *   Generated files by language, valid for `requestRevision`.
 * @property {string} language The selected output tab.
 * @property {Job | null} job The running job, if any.
 */

/**
 * Open a workspace: every schema outside include/ is an entrypoint, and the
 * first schema (or the first file) is shown. A replacement passes a revision
 * above the old one so results from the old workspace are discarded, and an
 * import stays `dirty` because a download never proves the files were kept.
 * @param {ReadonlyMap<string, Uint8Array>} files
 * @param {{ revision?: number, dirty?: boolean }} [options]
 * @returns {Workspace}
 */
export function openWorkspace(files, { revision = 0, dirty = false } = {}) {
  const paths = [...files.keys()];
  return {
    files: new Map(files),
    entrypoints: new Set(paths.filter(isSchema)),
    activeFile: paths.find(isSchema) ?? paths[0] ?? "",
    revision,
    dirty,
  };
}

/**
 * @param {Workspace} workspace
 * @param {string} path
 * @returns {Workspace}
 */
export function selectFile(workspace, path) {
  if (!workspace.files.has(path)) throw new Error(`No file at ${path}.`);
  return { ...workspace, activeFile: path };
}

/**
 * Replace the contents of an existing file.
 * @param {Workspace} workspace
 * @param {string} path
 * @param {Uint8Array} bytes
 * @returns {Workspace}
 */
export function editFile(workspace, path, bytes) {
  if (!workspace.files.has(path)) throw new Error(`No file at ${path}.`);
  const files = new Map(workspace.files);
  files.set(path, bytes);
  return { ...workspace, files, revision: workspace.revision + 1, dirty: true };
}

/**
 * Add a file, check it as an entrypoint when it is a schema, and show it.
 * @param {Workspace} workspace
 * @param {string} path An already checked relative path.
 * @param {Uint8Array} bytes
 * @returns {Workspace}
 */
export function addFile(workspace, path, bytes) {
  if (workspace.files.has(path)) {
    throw new Error("A file already uses this path.");
  }
  const files = new Map(workspace.files);
  files.set(path, bytes);
  validateFiles(files);
  const entrypoints = new Set(workspace.entrypoints);
  if (isSchema(path)) entrypoints.add(path);
  return {
    files,
    entrypoints,
    activeFile: path,
    revision: workspace.revision + 1,
    dirty: true,
  };
}

/**
 * Move a file to a new path, keeping its entrypoint status where the new path
 * is still a schema. Imports inside other files are not rewritten.
 * @param {Workspace} workspace
 * @param {string} from
 * @param {string} to An already checked relative path.
 * @returns {Workspace}
 */
export function renameFile(workspace, from, to) {
  const bytes = workspace.files.get(from);
  if (!bytes) throw new Error(`No file at ${from}.`);
  if (to === from) return workspace;
  if (workspace.files.has(to)) {
    throw new Error("A file already uses this path.");
  }
  const files = new Map(workspace.files);
  files.delete(from);
  files.set(to, bytes);
  validateFiles(files);
  const entrypoints = new Set(workspace.entrypoints);
  const wasEntry = entrypoints.delete(from);
  if (isSchema(to) && wasEntry) entrypoints.add(to);
  return {
    files,
    entrypoints,
    activeFile: workspace.activeFile === from ? to : workspace.activeFile,
    revision: workspace.revision + 1,
    dirty: true,
  };
}

/**
 * Remove a file. The last file cannot be removed; deleting the shown file
 * shows the first remaining one.
 * @param {Workspace} workspace
 * @param {string} path
 * @returns {Workspace}
 */
export function deleteFile(workspace, path) {
  if (!workspace.files.has(path)) throw new Error(`No file at ${path}.`);
  if (workspace.files.size <= 1) {
    throw new Error("A workspace needs at least one file.");
  }
  const files = new Map(workspace.files);
  files.delete(path);
  const entrypoints = new Set(workspace.entrypoints);
  entrypoints.delete(path);
  return {
    files,
    entrypoints,
    activeFile: workspace.activeFile === path
      ? /** @type {string} */ (files.keys().next().value)
      : workspace.activeFile,
    revision: workspace.revision + 1,
    dirty: true,
  };
}

/**
 * Check or uncheck a schema as a compilation entrypoint.
 * @param {Workspace} workspace
 * @param {string} path
 * @param {boolean} checked
 * @returns {Workspace}
 */
export function setEntrypoint(workspace, path, checked) {
  if (!isSchema(path) || !workspace.files.has(path)) {
    throw new Error(`${path} is not a schema in this workspace.`);
  }
  if (workspace.entrypoints.has(path) === checked) return workspace;
  const entrypoints = new Set(workspace.entrypoints);
  if (checked) entrypoints.add(path);
  else entrypoints.delete(path);
  return {
    ...workspace,
    entrypoints,
    revision: workspace.revision + 1,
    dirty: true,
  };
}

/**
 * @param {string} language
 * @returns {Session}
 */
export function createSession(language) {
  return {
    request: undefined,
    requestRevision: -1,
    outputs: new Map(),
    language,
    job: null,
  };
}

/**
 * Forget the cached request and every output: the workspace changed.
 * @param {Session} session
 * @returns {Session}
 */
export function invalidate(session) {
  return {
    ...session,
    request: undefined,
    requestRevision: -1,
    outputs: new Map(),
  };
}

/**
 * @param {Session} session
 * @param {number} revision
 * @returns {boolean} Whether the cached request matches this revision.
 */
export function canReuseRequest(session, revision) {
  return session.request !== undefined && session.requestRevision === revision;
}

/**
 * Selecting a tab generates on its own only when the request is current, the
 * language has no output yet, and nothing is running.
 * @param {Session} session
 * @param {number} revision
 * @param {string} language
 * @returns {boolean}
 */
export function shouldAutoRun(session, revision, language) {
  return session.job === null && canReuseRequest(session, revision) &&
    !session.outputs.has(language);
}

/**
 * @param {Session} session
 * @param {number} revision The current workspace revision.
 * @returns {boolean} Whether the running job compiles an older snapshot.
 */
export function isJobStale(session, revision) {
  return session.job !== null && session.job.revision !== revision;
}

/**
 * @param {Session} session
 * @param {number} revision
 * @param {readonly string[]} targets
 * @returns {Session}
 */
export function beginJob(session, revision, targets) {
  if (session.job) throw new Error("A job is already running.");
  return { ...session, job: { revision, targets: [...targets] } };
}

/**
 * Record a finished job. Results from a snapshot that is no longer current are
 * discarded; they can never overwrite the state of newer edits.
 * @param {Session} session
 * @param {number} revision The current workspace revision.
 * @param {number} jobRevision
 * @param {Uint8Array} request
 * @param {Readonly<Partial<Record<string, Readonly<Record<string, Uint8Array>>>>>} outputs
 * @returns {{ session: Session, applied: boolean }}
 */
export function completeJob(session, revision, jobRevision, request, outputs) {
  if (jobRevision !== revision) {
    return { session: { ...session, job: null }, applied: false };
  }
  const merged = new Map(session.outputs);
  for (const [language, entries] of Object.entries(outputs)) {
    if (entries) merged.set(language, entries);
  }
  return {
    session: {
      ...session,
      request,
      requestRevision: jobRevision,
      outputs: merged,
      job: null,
    },
    applied: true,
  };
}

/**
 * Record a failed or cancelled job. A failure for the current snapshot drops
 * the outputs of its targets, so a previous success is never offered as the
 * result of this run; other languages keep their output.
 * @param {Session} session
 * @param {number} revision The current workspace revision.
 * @param {number} jobRevision
 * @param {readonly string[]} targets
 * @param {boolean} [cancelled] A cancelled job changes nothing but the job slot.
 * @returns {{ session: Session, applied: boolean }}
 */
export function failJob(session, revision, jobRevision, targets, cancelled) {
  if (jobRevision !== revision || cancelled) {
    return { session: { ...session, job: null }, applied: false };
  }
  const outputs = new Map(session.outputs);
  for (const target of targets) outputs.delete(target);
  return { session: { ...session, outputs, job: null }, applied: true };
}

/**
 * Roving focus over the language tabs: arrows wrap, Home and End jump. Other
 * keys are ignored.
 * @template T
 * @param {readonly T[]} order
 * @param {T} current
 * @param {string} key
 * @returns {T | undefined}
 */
export function tabTarget(order, current, key) {
  const index = order.indexOf(current);
  if (index < 0 || order.length === 0) return undefined;
  switch (key) {
    case "ArrowRight":
      return order[(index + 1) % order.length];
    case "ArrowLeft":
      return order[(index + order.length - 1) % order.length];
    case "Home":
      return order[0];
    case "End":
      return order[order.length - 1];
    default:
      return undefined;
  }
}

/**
 * The editor split as a percentage of the width left of the resize handle.
 * @param {number} percent
 * @returns {number}
 */
export function clampSplit(percent) {
  if (!Number.isFinite(percent)) return 50;
  return Math.max(25, Math.min(75, Math.round(percent)));
}

/**
 * A Go package name for a schema file: its base name as a lower-case Go
 * identifier, falling back to `schema`.
 * @param {string} path
 * @returns {string}
 */
export function goPackageName(path) {
  const base = (path.split("/").at(-1) ?? "").replace(/\.capnp$/, "");
  const name = base.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(
    /^[0-9_]+/,
    "",
  );
  return name || "schema";
}

const directoryOf = (/** @type {string} */ path) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/**
 * The Go import path for a new schema, derived from a reference schema: the
 * reference's `$Go.import` with its own directory removed, then the new file's
 * directory appended, so files in one directory share an import path.
 * @param {{ path: string, text: string }} reference The schema shown when the file is added.
 * @param {string} path The new file's path.
 * @param {string} [fallback] The root used when the reference declares no import.
 * @returns {string}
 */
export function goImportPath(reference, path, fallback = "example.com/studio") {
  const declared = /\$Go\.import\("([^"\n]+)"\)/.exec(reference.text)?.[1];
  let root = fallback;
  if (declared) {
    const directory = directoryOf(reference.path);
    root = directory && declared.endsWith(`/${directory}`)
      ? declared.slice(0, -directory.length - 1)
      : declared;
  }
  const directory = directoryOf(path);
  return directory ? `${root}/${directory}` : root;
}

/**
 * The C++ namespace declared by a reference schema, or `studio`.
 * @param {string} text
 * @returns {string}
 */
export function cxxNamespace(text) {
  return /\$Cxx\.namespace\("([^"\n]+)"\)/.exec(text)?.[1] ?? "studio";
}

/**
 * A 64-bit schema id with the high bit set, formatted as a hex literal.
 * @param {number} high 32 random bits.
 * @param {number} low 32 random bits.
 * @returns {string}
 */
export function schemaId(high, low) {
  const value = (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0) | (1n << 63n);
  return `0x${value.toString(16)}`;
}

/**
 * The text of a new schema file: a unique id plus the C++ and Go annotations
 * every generator needs, so Go and "Generate all" succeed on a fresh file.
 * @param {string} path The new file's path.
 * @param {string} id A `0x...` schema id.
 * @param {{ path: string, text: string }} reference The schema shown when the file is added.
 * @returns {string}
 */
export function schemaTemplate(path, id, reference) {
  return `@${id};
using Cxx = import "/capnp/c++.capnp";
$Cxx.namespace("${cxxNamespace(reference.text)}");
using Go = import "/go.capnp";
$Go.package("${goPackageName(path)}");
$Go.import("${goImportPath(reference, path)}");

struct Example {
  value @0 :Text;
}
`;
}
