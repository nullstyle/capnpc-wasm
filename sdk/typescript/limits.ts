import {
  type CompileRequest,
  type CompilerOptions,
  defaultLimits,
  type Files,
  type GenerationRequest,
  type ResourceLimits,
} from "./types.ts";

export function resolveLimits(options: CompilerOptions = {}): ResourceLimits {
  const limits: ResourceLimits = { ...defaultLimits };
  for (const [name, value] of Object.entries(options.limits ?? {})) {
    if (
      !Object.hasOwn(limits, name) || !Number.isSafeInteger(value) || value < 0
    ) {
      throw new TypeError(`invalid resource limit: ${name}`);
    }
    limits[name] = value;
  }
  if (limits.memoryPages < 1 || limits.memoryPages > 65536) {
    throw new TypeError("memoryPages must be between 1 and 65536");
  }
  return Object.freeze(limits);
}

// Count without allocating encoded storage, including TextEncoder's replacement
// semantics for lone surrogates. Stop once the caller's remaining budget fails.
function utf8Size(text: string, maximum: number): number {
  if (text.length > maximum) return maximum + 1;
  let size = 0;
  for (const point of text) {
    const code = point.codePointAt(0)!;
    size += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (size > maximum) break;
  }
  return size;
}

export function checkPath(path: string, limits: ResourceLimits): void {
  if (
    typeof path !== "string" ||
    utf8Size(path, limits.pathBytes) > limits.pathBytes
  ) {
    throw new TypeError("path exceeds pathBytes limit");
  }
  if (
    /[\\\0]/.test(path) || !path.isWellFormed() ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new TypeError(`expected a canonical relative POSIX path: ${path}`);
}

/** Validate both mounts before encoding or copying any file contents. */
export function validateWorkspace(
  input: CompileRequest,
  limits: ResourceLimits,
): [Files, Files] {
  if (input.entrypoints.length > limits.workspaceEntries) {
    throw new TypeError("entrypoints exceed workspaceEntries limit");
  }
  if (input.generators.length > 4) throw new TypeError("too many generators");
  const captured: Record<string, string | Uint8Array>[] = [];
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
  }
  return captured as [Files, Files];
}

export function validateGeneration(
  input: GenerationRequest,
  limits: ResourceLimits,
): Uint8Array {
  if (input.generators.length > 4) throw new TypeError("too many generators");
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
  return request;
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
