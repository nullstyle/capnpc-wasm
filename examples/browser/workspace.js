import { zipSync } from "fflate";

export const limits = { bytes: 8 * 1024 * 1024, entries: 128 };
export const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function checkPath(path) {
  if (
    !path || path.length > 512 || path.includes("\\") ||
    [...path].some((char) =>
      char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
    ) ||
    !path.isWellFormed() ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new Error("Use a relative path such as types/common.capnp.");
  return path;
}

export function validateFiles(files) {
  if (!files.size) throw new Error("Choose at least one file.");
  if (files.size > limits.entries) {
    throw new Error("A workspace can contain up to 128 files.");
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
    throw new Error("The workspace exceeds the 8 MiB limit.");
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

// A directory picker supplies a common top-level folder. Strip exactly that
// folder; nested import paths and binary embed bytes remain untouched.
export async function importFiles(selected, directory = false) {
  const picked = [...selected];
  if (!picked.length) return null;
  if (
    picked.length > limits.entries ||
    picked.reduce((n, f) => n + f.size, 0) > limits.bytes
  ) {
    throw new Error("Choose at most 128 files totaling no more than 8 MiB.");
  }
  const files = new Map();
  for (const file of picked) {
    const relative = directory ? file.webkitRelativePath : file.name;
    const path = checkPath(
      directory ? relative.slice(relative.indexOf("/") + 1) : relative,
    );
    if (files.has(path)) {
      throw new Error(
        `More than one file is named ${path}. Use Open folder to preserve folders.`,
      );
    }
    files.set(path, new Uint8Array(await file.arrayBuffer()));
  }
  validateFiles(files);
  return files;
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
