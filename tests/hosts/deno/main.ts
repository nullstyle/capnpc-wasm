import WASI from "../../../ref/browser_wasi_shim/src/wasi.ts";
import { Inode } from "../../../ref/browser_wasi_shim/src/fd.ts";
import {
  Directory,
  File,
  OpenFile,
  PreopenDirectory,
} from "../../../ref/browser_wasi_shim/src/fs_mem.ts";

function checkName(name: string): void {
  if (
    !name || name === "." || name === ".." || /[\\/\0]/.test(name)
  ) {
    throw new Error(`invalid filesystem entry name: ${JSON.stringify(name)}`);
  }
}

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
  while (args[0]?.startsWith("--")) {
    const option = args.shift();
    if (option !== "--dir" || rootPath !== undefined) {
      throw new Error("only one --dir host::/ mount is supported");
    }
    const mount = args.shift();
    if (!mount?.endsWith("::/") || mount.length <= 3) {
      throw new Error("directory mount must be host::/");
    }
    rootPath = mount.slice(0, -3);
  }
  const modulePath = args[0];
  if (!modulePath) {
    throw new Error("usage: main.ts [--dir host::/] module.wasm [args...]");
  }

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
  // The pinned shim counts UTF-16 code units here, but args_get writes UTF-8.
  // Keep this narrow ABI correction in the adapter, outside the reference.
  wasi.wasiImport.args_sizes_get = (
    argc: number,
    bufferSize: number,
  ): number => {
    const memory = new DataView(wasi.inst.exports.memory.buffer);
    const encoder = new TextEncoder();
    memory.setUint32(argc, args.length, true);
    memory.setUint32(
      bufferSize,
      args.reduce((size, arg) => size + encoder.encode(arg).length + 1, 0),
      true,
    );
    return 0;
  };
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
  if (code === 0 && root && rootPath) await exportDirectory(root, rootPath);
  return code;
}

try {
  Deno.exit(await main());
} catch (error) {
  console.error(
    "deno-wasi-run:",
    error instanceof Error ? error.message : error,
  );
  Deno.exit(1);
}
