// The pinned shim through the SDK's typed facade, and the SDK's corrections
// to its ABI: the parity rows run the same adapter code the SDK ships.
import {
  Directory,
  File,
  type Inode,
  OpenFile,
  PreopenDirectory,
  WASI,
} from "../../../sdk/typescript/shim.ts";
import { checkName, correctShimAbi } from "../../../sdk/typescript/shim-abi.ts";

/** A command-line error; exits 2 instead of the host-failure status. */
class UsageError extends Error {}

/** Exit status for traps, uncaught exceptions, and host failures. */
const HOST_FAILURE_EXIT = 70;

async function loadDirectory(path: string): Promise<Directory> {
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink) {
    throw new Error(`expected a directory, without symlinks: ${path}`);
  }
  const contents = new Map<string, Inode>();
  for await (const entry of Deno.readDir(path)) {
    checkName(entry.name);
    const entryPath = `${path}/${entry.name}`;
    if (entry.isSymlink) {
      throw new Error(`symlinks are unsupported: ${entryPath}`);
    }
    if (entry.isDirectory) {
      contents.set(entry.name, await loadDirectory(entryPath));
    } else if (entry.isFile) {
      contents.set(entry.name, new File(await Deno.readFile(entryPath)));
    } else {
      throw new Error(`unsupported filesystem entry: ${entryPath}`);
    }
  }
  return new Directory(contents);
}

async function statIfPresent(path: string): Promise<Deno.FileInfo | null> {
  try {
    const info = await Deno.lstat(path);
    if (info.isSymlink) {
      throw new Error(`refusing to export through symlink: ${path}`);
    }
    return info;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function exportDirectory(
  directory: Directory,
  path: string,
): Promise<void> {
  const info = await statIfPresent(path);
  if (info && !info.isDirectory) throw new Error(`not a directory: ${path}`);
  if (!info) await Deno.mkdir(path);
  for (const [name, inode] of directory.contents) {
    checkName(name);
    const entryPath = `${path}/${name}`;
    if (inode instanceof Directory) {
      await exportDirectory(inode, entryPath);
    } else if (inode instanceof File) {
      const existingInfo = await statIfPresent(entryPath);
      if (existingInfo && !existingInfo.isFile) {
        throw new Error(`not a regular file: ${entryPath}`);
      }
      const previous = existingInfo ? await Deno.readFile(entryPath) : null;
      if (
        previous && previous.length === inode.data.length &&
        previous.every((value, index) => value === inode.data[index])
      ) continue;
      await Deno.writeFile(entryPath, inode.data);
    } else {
      throw new Error(`unsupported generated filesystem entry: ${entryPath}`);
    }
  }
}

async function writeAll(
  writer: { write(data: Uint8Array): Promise<number> },
  data: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    offset += await writer.write(data.subarray(offset));
  }
}

async function main(): Promise<number> {
  const args = [...Deno.args];
  let rootPath: string | undefined;
  let exportAlways = false;
  while (args[0]?.startsWith("--")) {
    const option = args.shift();
    if (option === "--export-always") {
      exportAlways = true;
      continue;
    }
    if (option !== "--dir" || rootPath !== undefined) {
      throw new UsageError("only one --dir host::/ mount is supported");
    }
    const mount = args.shift();
    if (!mount?.endsWith("::/") || mount.length <= 3) {
      throw new UsageError("directory mount must be host::/");
    }
    rootPath = mount.slice(0, -3);
  }
  const modulePath = args[0];
  if (!modulePath) {
    throw new UsageError(
      "usage: main.ts [--dir host::/] [--export-always] module.wasm [args...]",
    );
  }
  // The guest sees the tool name (capnp, capnpc-c++, ...), as the SDKs and the
  // packaged launcher pass it, so diagnostics do not leak the host module path.
  args[0] = modulePath.slice(modulePath.lastIndexOf("/") + 1).replace(
    /\.wasm$/,
    "",
  );

  const root = rootPath ? await loadDirectory(rootPath) : null;
  const input = new File(await new Response(Deno.stdin.readable).arrayBuffer());
  const output = new File([]);
  const errors = new File([]);
  const fds = [new OpenFile(input), new OpenFile(output), new OpenFile(errors)];
  const wasi = new WASI(
    args,
    [],
    root ? [...fds, new PreopenDirectory("/", root.contents)] : fds,
    { debug: false },
  );
  // path_readlink for trees without symlinks, and UTF-8 argument sizes.
  correctShimAbi(wasi, args);
  let code: number;
  try {
    const { instance } = await WebAssembly.instantiate(
      await Deno.readFile(modulePath),
      { wasi_snapshot_preview1: wasi.wasiImport },
    );
    const { memory, _start } = instance.exports;
    if (
      !(memory instanceof WebAssembly.Memory) || typeof _start !== "function"
    ) {
      throw new Error("module must export memory and _start");
    }
    code = wasi.start({ exports: { memory, _start: () => _start() } });
  } finally {
    await writeAll(Deno.stdout, output.data);
    await writeAll(Deno.stderr, errors.data);
  }
  // Export is transactional: only a successful exit publishes the guest's
  // files. --export-always is a test-only bypass so negative-path tests can
  // observe what a failing guest wrote.
  if (root && rootPath && (code === 0 || exportAlways)) {
    await exportDirectory(root, rootPath);
  }
  return code;
}

try {
  Deno.exit(await main());
} catch (error) {
  // A guest exit reaches main() as a status; anything thrown here is a trap,
  // an uncaught guest exception, a host failure, or a usage error. None of
  // them may look like the guest's own exit 1.
  console.error(
    "deno-wasi-run:",
    error instanceof Error ? error.message : error,
  );
  Deno.exit(error instanceof UsageError ? 2 : HOST_FAILURE_EXIT);
}
