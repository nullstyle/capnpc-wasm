import WASI from "../../ref/browser_wasi_shim/src/wasi.ts";
import {
  Directory,
  File,
  OpenDirectory,
  OpenFile,
  PreopenDirectory,
} from "../../ref/browser_wasi_shim/src/fs_mem.ts";
import {
  ERRNO_BADF,
  ERRNO_INVAL,
  ERRNO_NOTDIR,
  ERRNO_ROFS,
  OFLAGS_CREAT,
  OFLAGS_TRUNC,
} from "../../ref/browser_wasi_shim/src/wasi_defs.ts";

export interface CommandResult {
  code: number;
  stdout: Uint8Array;
  stderr: string;
  files: Record<string, Uint8Array>;
}

export class CommandError extends Error {
  override readonly name = "CommandError";

  constructor(message: string, public readonly stderr: string, cause: unknown) {
    super(message, { cause });
  }
}

function checkName(name: string): void {
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw new Error(`invalid filesystem entry name: ${JSON.stringify(name)}`);
  }
}

function stageFiles(
  files: Record<string, Uint8Array>,
  readonly: boolean,
): Directory {
  const root = new Directory(new Map());
  // The compiler is always given /src and /include, including workspaces that
  // use no annotation or standard include files.
  if (readonly) {
    for (const name of ["src", "include"]) {
      const directory = new Directory(new Map());
      directory.parent = root;
      root.contents.set(name, directory);
    }
  }
  for (const [path, data] of Object.entries(files)) {
    const parts = path.split("/");
    for (const part of parts) checkName(part);
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      const existing = directory.contents.get(part);
      if (existing && !(existing instanceof Directory)) {
        throw new Error(`file and directory paths overlap: ${path}`);
      }
      const child = existing instanceof Directory
        ? existing
        : new Directory(new Map());
      child.parent = directory;
      directory.contents.set(part, child);
      directory = child;
    }
    const name = parts[parts.length - 1];
    if (directory.contents.has(name)) {
      throw new Error(`file and directory paths overlap: ${path}`);
    }
    // File copies a typed array, keeping the caller's input out of guest memory.
    directory.contents.set(name, new File(data, { readonly }));
  }
  return root;
}

function collectFiles(directory: Directory): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = Object.create(null);
  const ancestors = new Set<Directory>();
  function visit(current: Directory, prefix: string): void {
    if (ancestors.has(current)) throw new Error("generated directory cycle");
    ancestors.add(current);
    for (const [name, inode] of current.contents) {
      checkName(name);
      const path = prefix + name;
      if (inode instanceof Directory) {
        visit(inode, path + "/");
      } else if (inode instanceof File) {
        // The shim may leave files backed by resizable ArrayBuffers, which are
        // rejected by some Web APIs and must not escape this command instance.
        files[path] = new Uint8Array(inode.data);
      } else {
        throw new Error(`unsupported generated filesystem entry: ${path}`);
      }
    }
    ancestors.delete(current);
  }
  visit(directory, "");
  return files;
}

function protectFiles(wasi: WASI, readonly: boolean): void {
  // File.readonly protects writes and path_open truncation in the pinned shim,
  // but OpenFile's allocation and size operations do not check it themselves.
  // Inspect the file object so protection survives fd_close/fd_renumber.
  for (
    const name of [
      "fd_allocate",
      "fd_filestat_set_size",
      "fd_filestat_set_times",
    ]
  ) {
    const original = wasi.wasiImport[name];
    wasi.wasiImport[name] = (fd: number, ...args: unknown[]) => {
      const descriptor = wasi.fds[fd];
      if (descriptor instanceof OpenFile && descriptor.file.readonly) {
        return ERRNO_ROFS;
      }
      return original(fd, ...args);
    };
  }
  if (!readonly) return;

  for (
    const name of [
      "path_create_directory",
      "path_filestat_set_times",
      "path_link",
      "path_rename",
      "path_remove_directory",
      "path_symlink",
      "path_unlink_file",
    ]
  ) {
    wasi.wasiImport[name] = () => ERRNO_ROFS;
  }
  const pathOpen = wasi.wasiImport.path_open;
  wasi.wasiImport.path_open = (
    fd: number,
    flags: number,
    path: number,
    length: number,
    oflags: number,
    ...args: unknown[]
  ) => {
    if (oflags & (OFLAGS_CREAT | OFLAGS_TRUNC)) return ERRNO_ROFS;
    return pathOpen(fd, flags, path, length, oflags, ...args);
  };
}

/** Execute a pinned WASI command in a fresh memory filesystem. */
export async function runCommand(
  module: WebAssembly.Module,
  args: string[],
  stdin: Uint8Array,
  files: Record<string, Uint8Array>,
  readonly: boolean,
): Promise<CommandResult> {
  const root = stageFiles(files, readonly);
  const output = new File([]);
  const errors = new File([]);
  const argv = [...args];
  const wasi = new WASI(argv, [], [
    new OpenFile(new File(stdin, { readonly: true })),
    new OpenFile(output),
    new OpenFile(errors),
    new PreopenDirectory("/", root.contents),
  ], { debug: false });
  protectFiles(wasi, readonly);

  // The in-memory filesystem has no symlinks. Zig checks each output path
  // with readlink before writing; preserve lookup failures and report INVAL
  // for existing non-links instead of the shim's default NOTSUP.
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

  // args_get writes UTF-8, whereas the pinned shim's sizing counts UTF-16.
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

  let code: number;
  try {
    const instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: wasi.wasiImport,
    });
    const { memory, _start } = instance.exports;
    if (
      !(memory instanceof WebAssembly.Memory) || typeof _start !== "function"
    ) {
      throw new Error("WASI command must export memory and _start");
    }
    code = wasi.start({ exports: { memory, _start: () => _start() } });
  } catch (cause) {
    const stderr = new TextDecoder().decode(new Uint8Array(errors.data));
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new CommandError(
      `WASI command failed: ${message}${stderr ? `\n${stderr}` : ""}`,
      stderr,
      cause,
    );
  }
  return {
    code,
    stdout: new Uint8Array(output.data),
    stderr: new TextDecoder().decode(new Uint8Array(errors.data)),
    files: code === 0 && !readonly ? collectFiles(root) : Object.create(null),
  };
}
