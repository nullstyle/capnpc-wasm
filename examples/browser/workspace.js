import { unzipSync, zipSync } from "fflate";

// Studio's user-facing budget. compiler.js derives the SDK limits from it by
// adding the bundled standard schemas, so a workspace the sidebar accepts is
// never rejected by the compiler for its size.
export const limits = {
  /** Bytes of user file contents. */
  bytes: 8 * 1024 * 1024,
  /** Files. */
  entries: 128,
  /** Files plus the folders their paths imply, as the SDK counts entries. */
  nodes: 512,
  /** Characters per path. */
  pathLength: 512,
};
export const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function checkPath(path) {
  if (
    !path || path.length > limits.pathLength || path.includes("\\") ||
    [...path].some((char) =>
      char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
    ) ||
    !path.isWellFormed() ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new Error("Use a relative path such as types/common.capnp.");
  return path;
}

/**
 * Whether a path has a dot-prefixed segment or a macOS resource fork folder.
 * Traversal segments are not hidden files; checkPath rejects them.
 */
export function isHidden(path) {
  return path.split("/").some((part) =>
    (part.startsWith(".") && part !== "." && part !== "..") ||
    part === "__MACOSX"
  );
}

/** Count files plus the folders their paths imply, as the SDK budgets entries. */
export function countNodes(paths) {
  const nodes = new Set();
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      nodes.add(parts.slice(0, i).join("/"));
    }
  }
  return nodes.size;
}

export function validateFiles(files) {
  if (!files.size) throw new Error("Choose at least one file.");
  if (files.size > limits.entries) {
    throw new Error(
      `A workspace can contain up to ${limits.entries} files; this one has ${files.size}.`,
    );
  }
  let size = 0;
  for (const [path, bytes] of files) {
    checkPath(path);
    size += bytes.length;
    const parts = path.split("/");
    parts.pop();
    while (parts.length) {
      if (files.has(parts.join("/"))) {
        throw new Error(`A file and folder share the path ${parts.join("/")}.`);
      }
      parts.pop();
    }
  }
  if (size > limits.bytes) {
    throw new Error(
      `A workspace can contain up to ${
        formatBytes(limits.bytes)
      }; this one has ${formatBytes(size)}.`,
    );
  }
  const nodes = countNodes(files.keys());
  if (nodes > limits.nodes) {
    throw new Error(
      `A workspace can contain up to ${limits.nodes} files and folders combined; this one has ${nodes}.`,
    );
  }
}

export function textOf(bytes) {
  try {
    const text = decoder.decode(bytes);
    // Treat control bytes as binary while allowing tabs and line endings.
    // deno-lint-ignore no-control-regex
    return /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) ? null : text;
  } catch {
    return null;
  }
}

export function isSchema(path) {
  return path.endsWith(".capnp") && !path.startsWith("include/");
}

export function compileWorkspace(files, entrypoints, standardIncludes) {
  validateFiles(files);
  if (!entrypoints.size) {
    throw new Error(
      "Select at least one schema to generate in the workspace sidebar.",
    );
  }
  const sources = Object.create(null);
  const includes = Object.assign(Object.create(null), standardIncludes);
  for (const [path, bytes] of files) {
    if (path.startsWith("include/")) includes[path.slice(8)] = bytes;
    else sources[path] = bytes;
  }
  return {
    files: sources,
    includeFiles: includes,
    entrypoints: [...entrypoints].sort(),
    generators: [],
  };
}

/**
 * Expand a ZIP archive into workspace files. Directory entries and hidden
 * paths are skipped, and one common top-level folder is stripped the way the
 * folder picker strips it. The entry count and the declared uncompressed sizes
 * are checked against the limits before any entry is inflated, so an archive
 * cannot claim more memory than a workspace may hold.
 */
export function unzipArchive(bytes) {
  let count = 0;
  let declared = 0;
  let hidden = 0;
  let raw;
  try {
    raw = unzipSync(bytes, {
      filter(entry) {
        if (entry.name.endsWith("/")) return false;
        if (isHidden(entry.name)) {
          hidden++;
          return false;
        }
        if (++count > limits.entries) {
          throw new Error(
            `The archive has more than ${limits.entries} files.`,
          );
        }
        declared += entry.originalSize;
        if (declared > limits.bytes) {
          throw new Error(
            `The archive expands to more than ${formatBytes(limits.bytes)}.`,
          );
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof Error && !("code" in error)) throw error;
    throw new Error("The ZIP archive could not be read.", { cause: error });
  }
  const names = Object.keys(raw);
  const first = names[0] ?? "";
  const top = first.includes("/") ? first.slice(0, first.indexOf("/") + 1) : "";
  // Strip one shared folder, never a traversal segment.
  const strip = top !== "" && top !== "./" && top !== "../" &&
    names.every((name) => name.startsWith(top));
  const files = new Map();
  for (const name of names) {
    const relative = strip ? name.slice(top.length) : name;
    let path;
    try {
      path = checkPath(relative);
    } catch {
      throw new Error(`The archive entry ${name} is not a relative path.`);
    }
    files.set(path, raw[name]);
  }
  return { files, hidden };
}

/**
 * Import picked files. A directory picker supplies a common top-level folder,
 * which is stripped so nested import paths stay relative; binary embed bytes
 * remain untouched. Hidden entries (dot-prefixed segments such as .git or
 * .DS_Store) are skipped and counted. In flat mode a .zip is expanded.
 */
export async function importFiles(selected, directory = false) {
  const picked = [...selected];
  if (!picked.length) return null;
  const visible = [];
  let hidden = 0;
  for (const file of picked) {
    const relative = directory ? file.webkitRelativePath : file.name;
    const path = directory
      ? relative.slice(relative.indexOf("/") + 1)
      : relative;
    if (isHidden(path)) hidden++;
    else visible.push({ file, path: checkPath(path) });
  }
  if (!visible.length) {
    throw new Error(
      `Nothing to import: all ${hidden} selected files are hidden.`,
    );
  }
  if (visible.length > limits.entries) {
    throw new Error(
      `Choose at most ${limits.entries} files; ${visible.length} were selected${
        hidden ? ` after skipping ${hidden} hidden files` : ""
      }.`,
    );
  }
  const total = visible.reduce((n, { file }) => n + file.size, 0);
  if (total > limits.bytes) {
    throw new Error(
      `Choose files totaling at most ${formatBytes(limits.bytes)}; ${
        formatBytes(total)
      } were selected.`,
    );
  }
  const files = new Map();
  let archives = 0;
  const add = (path, bytes) => {
    if (files.has(path)) {
      throw new Error(
        `More than one file is named ${path}. Use Open folder to preserve folders.`,
      );
    }
    files.set(path, bytes);
  };
  for (const { file, path } of visible) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!directory && /\.zip$/i.test(path)) {
      archives++;
      const expanded = unzipArchive(bytes);
      hidden += expanded.hidden;
      for (const [entry, contents] of expanded.files) add(entry, contents);
    } else add(path, bytes);
  }
  validateFiles(files);
  return { files, hidden, archives };
}

export function archive(files) {
  const entries = Object.create(null);
  for (const [path, bytes] of files) entries[checkPath(path)] = bytes;
  return zipSync(entries, { level: 6 });
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
