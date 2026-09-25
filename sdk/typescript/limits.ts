import {
  type CompileRequest,
  type CompilerOptions,
  defaultLimits,
  type Files,
  type GenerationRequest,
  type Language,
  type ResourceLimits,
} from "./types.ts";

export function resolveLimits(options: CompilerOptions = {}): ResourceLimits {
  const limits: ResourceLimits = { ...defaultLimits };
  const supplied = options.limits ?? {};
  if (typeof supplied !== "object" || supplied === null) {
    throw new TypeError("limits must be an object of resource limits");
  }
  for (const [name, value] of Object.entries(supplied)) {
    // Forwarded optional configuration commonly carries undefined entries;
    // they mean "use the default", exactly like an omitted field.
    if (value === undefined) continue;
    if (
      !Object.hasOwn(limits, name) || !Number.isSafeInteger(value) || value < 0
    ) {
      throw new TypeError(`invalid resource limit: ${name}`);
    }
    limits[name as keyof ResourceLimits] = value;
  }
  if (limits.memoryPages < 1 || limits.memoryPages > 65536) {
    throw new TypeError("memoryPages must be between 1 and 65536");
  }
  return Object.freeze(limits);
}

// Count without allocating encoded storage, including TextEncoder's replacement
// semantics for lone surrogates. Stop once the caller's remaining budget fails.
export function utf8Size(text: string, maximum: number): number {
  if (text.length > maximum) return maximum + 1;
  let size = 0;
  for (const point of text) {
    const code = point.codePointAt(0)!;
    size += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (size > maximum) break;
  }
  return size;
}

export function checkPath(
  path: unknown,
  limits: ResourceLimits,
): asserts path is string {
  if (typeof path !== "string") throw new TypeError("expected a string path");
  if (utf8Size(path, limits.pathBytes) > limits.pathBytes) {
    throw new TypeError("path exceeds pathBytes limit");
  }
  if (
    /[\\\0]/.test(path) || !path.isWellFormed() ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new TypeError(`expected a canonical relative POSIX path: ${path}`);
}

function validateGenerators(
  requested: unknown,
  supplied: ReadonlySet<Language>,
): Language[] {
  if (!Array.isArray(requested)) {
    throw new TypeError("generators must be an array of language names");
  }
  if (requested.length > 4) throw new TypeError("too many generators");
  if (new Set(requested).size !== requested.length) {
    throw new TypeError("duplicate generators");
  }
  for (const target of requested) {
    if (typeof target !== "string" || !supplied.has(target as Language)) {
      throw new TypeError(`generator was not supplied: ${String(target)}`);
    }
  }
  return [...requested] as Language[];
}

/** A compile request after every synchronous check, before any copy. */
export interface CompileJob {
  /** Validated views of `files`; string contents are still unencoded. */
  sources: Files;
  annotations: Files;
  entrypoints: string[];
  importPaths: string[];
  sourcePrefix: string;
  generators: Language[];
}

/**
 * Every synchronous check for compile, in one place, so the direct compiler
 * and the worker client reject identical inputs with identical TypeErrors
 * before encoding, copying, posting, or starting a guest. `supplied` is the
 * set of generator languages the factory received modules for.
 */
export function validateCompile(
  input: CompileRequest,
  limits: ResourceLimits,
  supplied: ReadonlySet<Language>,
): CompileJob {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("compile request must be an object");
  }
  if (typeof input.files !== "object" || input.files === null) {
    throw new TypeError("files must be an object mapping paths to contents");
  }
  if (
    input.includeFiles !== undefined &&
    (typeof input.includeFiles !== "object" || input.includeFiles === null)
  ) {
    throw new TypeError(
      "includeFiles must be an object mapping paths to contents",
    );
  }
  if (!Array.isArray(input.entrypoints)) {
    throw new TypeError("entrypoints must be an array of paths");
  }
  if (input.importPaths !== undefined && !Array.isArray(input.importPaths)) {
    throw new TypeError("importPaths must be an array of directory paths");
  }
  const generators = validateGenerators(input.generators, supplied);
  const importPaths = [...(input.importPaths ?? [])];
  if (importPaths.length > limits.workspaceEntries) {
    throw new TypeError("import root count exceeds workspaceEntries limit");
  }
  const sourcePrefix = input.sourcePrefix ?? "";
  for (const path of [sourcePrefix, ...importPaths]) {
    if (path !== "") checkPath(path, limits);
  }
  if (new Set(importPaths).size !== importPaths.length) {
    throw new TypeError("duplicate importPaths");
  }
  const entrypoints = [...input.entrypoints];
  if (entrypoints.length === 0) {
    throw new TypeError("at least one entrypoint is required");
  }
  if (entrypoints.length > limits.workspaceEntries) {
    throw new TypeError("entrypoint count exceeds workspaceEntries limit");
  }
  for (const path of entrypoints) checkPath(path, limits);
  if (new Set(entrypoints).size !== entrypoints.length) {
    throw new TypeError("duplicate entrypoints");
  }

  const captured: Record<string, string | Uint8Array>[] = [];
  const sourceNames = new Set<string>();
  const sourceDirectories = new Set<string>();
  let bytes = 0;
  let entries = 0;
  for (const files of [input.files, input.includeFiles ?? {}]) {
    const mount: Record<string, string | Uint8Array> = Object.create(null);
    captured.push(mount);
    const names = new Set<string>();
    const nodes = new Set<string>();
    for (const path in files) {
      if (!Object.hasOwn(files, path)) continue;
      checkPath(path, limits);
      names.add(path);
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const node = parts.slice(0, i).join("/");
        if (!nodes.has(node)) {
          nodes.add(node);
          if (++entries > limits.workspaceEntries) {
            throw new TypeError("workspace exceeds workspaceEntries limit");
          }
        }
      }
      let contents = files[path];
      if (typeof contents !== "string" && !(contents instanceof Uint8Array)) {
        throw new TypeError(`expected text or bytes for ${path}`);
      }
      if (contents instanceof Uint8Array) {
        contents = new Uint8Array(
          contents.buffer,
          contents.byteOffset,
          contents.length,
        );
      }
      mount[path] = contents;
      bytes += typeof contents === "string"
        ? utf8Size(contents, limits.workspaceBytes - bytes)
        : contents.length;
      if (bytes > limits.workspaceBytes) {
        throw new TypeError("workspace exceeds workspaceBytes limit");
      }
    }
    for (const path of names) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        if (names.has(parts.slice(0, i).join("/"))) {
          throw new TypeError(`file/directory collision: ${path}`);
        }
      }
    }
    if (files === input.files) {
      for (const name of names) sourceNames.add(name);
      for (const node of nodes) {
        if (!names.has(node)) sourceDirectories.add(node);
      }
    }
  }
  for (const path of entrypoints) {
    if (!sourceNames.has(path)) {
      throw new TypeError(`entrypoint is not in files: ${path}`);
    }
  }
  // Import roots and the source prefix name directories the guest will open;
  // reject them here rather than as a compiler exit or a kj exception.
  for (const path of importPaths) {
    if (path !== "" && !sourceDirectories.has(path)) {
      throw new TypeError(`importPath is not a directory in files: ${path}`);
    }
  }
  if (sourcePrefix !== "" && !sourceDirectories.has(sourcePrefix)) {
    throw new TypeError(
      `sourcePrefix is not a directory in files: ${sourcePrefix}`,
    );
  }
  const [sources, annotations] = captured as [Files, Files];
  return {
    sources,
    annotations,
    entrypoints,
    importPaths,
    sourcePrefix,
    generators,
  };
}

export interface GenerateJob {
  /** A validated view of the caller's bytes; callers copy before execution. */
  request: Uint8Array;
  generators: Language[];
}

export function validateGenerate(
  input: GenerationRequest,
  limits: ResourceLimits,
  supplied: ReadonlySet<Language>,
): GenerateJob {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("generation request must be an object");
  }
  const generators = validateGenerators(input.generators, supplied);
  if (generators.length === 0) {
    throw new TypeError("at least one generator is required");
  }
  if (!(input.request instanceof Uint8Array) || input.request.length === 0) {
    throw new TypeError(
      "request must contain unpacked CodeGeneratorRequest bytes",
    );
  }
  const request = new Uint8Array(
    input.request.buffer,
    input.request.byteOffset,
    input.request.length,
  );
  if (request.length > limits.requestBytes) {
    throw new TypeError("request exceeds requestBytes limit");
  }
  return { request, generators };
}

export function copyFiles(
  files: Files,
  prefix = "",
): Record<string, Uint8Array> {
  const result: Record<string, Uint8Array> = Object.create(null);
  for (const path in files) {
    if (!Object.hasOwn(files, path)) continue;
    const contents = files[path];
    result[prefix + path] = typeof contents === "string"
      ? new TextEncoder().encode(contents)
      : new Uint8Array(contents);
  }
  return result;
}
