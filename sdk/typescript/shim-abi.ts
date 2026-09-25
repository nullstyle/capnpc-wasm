/**
 * Corrections to the pinned browser_wasi_shim's WASI ABI, kept outside the
 * reference source. The SDK runtime and the Deno test host
 * (tests/hosts/deno/main.ts) both apply them, so a fix reaches the shipped
 * adapter and the parity host together.
 */
import {
  ERRNO_BADF,
  ERRNO_INVAL,
  ERRNO_NOTDIR,
  OpenDirectory,
  type WASI,
} from "./shim.ts";

/** Reject names the in-memory filesystem cannot hold as one path segment. */
export function checkName(name: string): void {
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw new Error(`invalid filesystem entry name: ${JSON.stringify(name)}`);
  }
}

/**
 * Install the ABI corrections on `wasi`, which was constructed with `argv`:
 *
 * - `path_readlink`: the in-memory filesystem has no symlinks. Zig checks
 *   each output path with readlink before writing; preserve lookup failures
 *   and report INVAL for existing non-links instead of the shim's NOTSUP.
 * - `args_sizes_get`: `args_get` writes UTF-8, whereas the shim's sizing
 *   counts UTF-16 code units, which is too small for non-ASCII arguments.
 */
export function correctShimAbi(wasi: WASI, argv: readonly string[]): void {
  wasi.wasiImport.path_readlink = (
    fd: number,
    path: number,
    length: number,
  ) => {
    const descriptor = wasi.fds[fd];
    if (!descriptor) return ERRNO_BADF;
    if (!(descriptor instanceof OpenDirectory)) return ERRNO_NOTDIR;
    const bytes = new Uint8Array(wasi.inst.exports.memory.buffer);
    const name = new TextDecoder().decode(bytes.subarray(path, path + length));
    const { ret } = descriptor.path_filestat_get(0, name);
    return ret || ERRNO_INVAL;
  };
  const encoder = new TextEncoder();
  const argumentBytes = argv.reduce(
    (size, arg) => size + encoder.encode(arg).length + 1,
    0,
  );
  wasi.wasiImport.args_sizes_get = (argc: number, bufferSize: number) => {
    const memory = new DataView(wasi.inst.exports.memory.buffer);
    memory.setUint32(argc, argv.length, true);
    memory.setUint32(bufferSize, argumentBytes, true);
    return 0;
  };
}
