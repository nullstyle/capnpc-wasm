// The native reference oracle: compiling requests with the pristine native
// compiler, canonicalizing CodeGeneratorRequests for byte comparison, and
// normalizing diagnostics so Wasm stderr can be compared with native stderr.

import { nativeBin, root } from "./paths.ts";
import { ldflags, mustSucceed } from "./process.ts";

/**
 * A native clang++ command line with the host's LDFLAGS appended, so a link
 * works in the toolchain env script's `-fuse-ld` fallback mode as well.
 */
export function clangxx(args: readonly string[]): string[] {
  return ["clang++", ...args, ...ldflags()];
}

/** Stages the pinned standard annotation schemas beneath `directory`. */
export async function stageStandardIncludes(directory: string): Promise<void> {
  await Deno.mkdir(`${directory}/capnp`, { recursive: true });
  await Deno.copyFile(
    `${root}/ref/capnproto/c++/src/capnp/c++.capnp`,
    `${directory}/capnp/c++.capnp`,
  );
  await Deno.copyFile(
    `${root}/ref/go-capnp/std/go.capnp`,
    `${directory}/go.capnp`,
  );
}

export interface NativeCompileOptions {
  /** Import roots passed as -I; standard imports are always disabled. */
  include?: string[];
  /** The --src-prefix stripped from requested file names. */
  srcPrefix?: string;
  /** Extra compiler arguments placed before the entrypoints. */
  args?: string[];
  cwd?: string;
  label?: string;
}

/** Compiles entrypoints with the native compiler and returns the request. */
export function nativeCompile(
  entrypoints: string[],
  options: NativeCompileOptions = {},
): Promise<Uint8Array> {
  const { include = [], srcPrefix, args = [], cwd, label } = options;
  return mustSucceed([
    `${nativeBin}/capnp`,
    "compile",
    "--no-standard-import",
    ...include.map((path) => `-I${path}`),
    ...(srcPrefix === undefined ? [] : [`--src-prefix=${srcPrefix}`]),
    ...args,
    "-o-",
    ...entrypoints,
  ], { cwd, label: label ?? "native compiler" });
}

/**
 * Sorts the request's nodes and sourceInfo by id and canonicalizes the
 * message. tests/normalize-request.c++ rejects trailing bytes, so appended
 * output or a second message cannot pass parity.
 */
export function canonicalRequest(request: Uint8Array): Promise<Uint8Array> {
  return mustSucceed([`${nativeBin}/normalize-request`], {
    stdin: request,
    label: "canonicalize CodeGeneratorRequest",
  });
}

export interface DiagnosticNormalization {
  /**
   * Path prefixes to remove, such as the native compiler root followed by
   * "/". The compiler prints paths relative to its working directory, so
   * pass both the absolute form and the form relative to the root.
   */
  stripPrefixes?: string[];
  /** Program names to replace with `capnp`-style tool names. */
  programNames?: Record<string, string>;
}

/**
 * Normalizes a diagnostic for native-versus-Wasm comparison: removes staging
 * path prefixes, masks generated 64-bit ids, and drops native KJ stack lines.
 */
export function normalizeDiagnostic(
  text: string,
  options: DiagnosticNormalization = {},
): string {
  let result = text;
  for (const prefix of options.stripPrefixes ?? []) {
    result = result.split(prefix).join("");
  }
  for (const [from, to] of Object.entries(options.programNames ?? {})) {
    result = result.split(from).join(to);
  }
  return result
    .replace(/@0x[0-9a-f]{16}/g, "@0x<id>")
    .split("\n")
    .filter((line) => !line.startsWith("stack: "))
    .join("\n");
}
