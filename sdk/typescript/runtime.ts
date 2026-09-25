import {
  boundedStream,
  boundFilesystem,
  boundWasiIO,
  LimitError,
} from "./resource-fs.ts";
import { checkPath, utf8Size } from "./limits.ts";
import { checkName, correctShimAbi } from "./shim-abi.ts";
import {
  Cancelled,
  countdownExport,
  interruptModule,
  interruptName,
  JobControl,
} from "./interrupt.ts";
import { defaultLimits, type ResourceLimits } from "./types.ts";
import {
  Directory,
  ERRNO_INTR,
  ERRNO_ROFS,
  File,
  OFLAGS_CREAT,
  OFLAGS_TRUNC,
  OpenFile,
  PreopenDirectory,
  WASI,
} from "./shim.ts";

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

/** The WASI preview1 functions the pinned shim implements, by import name. */
export const wasiImportNames: ReadonlySet<string> = new Set(
  Object.keys(new WASI([], [], [], { debug: false }).wasiImport),
);

/**
 * A file over bytes the caller already owns privately. Read-only files are
 * never resized or written by a guest, so sharing the buffer is safe and
 * saves a copy per staged file.
 */
function privateFile(data: Uint8Array, readonly: boolean): File {
  const file = new File(new ArrayBuffer(0), { readonly });
  file.data = data;
  return file;
}

function stageFiles(
  files: Record<string, Uint8Array>,
  readonly: boolean,
  copy: boolean,
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
    directory.contents.set(
      name,
      copy ? new File(data, { readonly }) : privateFile(data, readonly),
    );
  }
  return root;
}

function collectFiles(
  directory: Directory,
  limits: ResourceLimits,
): Record<string, Uint8Array> {
  const pending = [{ directory, prefix: "" }];
  const visited = new Set<Directory>();
  const selected: [string, File][] = [];
  let bytes = 0;
  let entries = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (visited.has(current.directory)) {
      throw new Error("generated directory cycle or alias");
    }
    visited.add(current.directory);
    for (const [name, inode] of current.directory.contents) {
      checkName(name);
      const path = current.prefix + name;
      // An overlong path is a budget the guest exceeded, reported as a limit
      // like the others; checkPath then only rejects non-canonical names.
      if (utf8Size(path, limits.pathBytes) > limits.pathBytes) {
        throw new LimitError("pathBytes");
      }
      checkPath(path, limits);
      if (++entries > limits.outputEntries) {
        throw new LimitError("outputEntries");
      }
      if (inode instanceof Directory) {
        pending.push({ directory: inode, prefix: path + "/" });
      } else if (inode instanceof File) {
        bytes += inode.data.length;
        if (bytes > limits.outputBytes) throw new LimitError("outputBytes");
        selected.push([path, inode]);
      } else throw new Error(`unsupported generated filesystem entry: ${path}`);
    }
  }
  // Validate the complete output before copying it, including hard-link aliases.
  // The result is a plain object so both execution modes return one shape;
  // guest-chosen names such as "__proto__" are defined as own data properties.
  const files: Record<string, Uint8Array> = {};
  for (const [path, inode] of selected) {
    Object.defineProperty(files, path, {
      value: new Uint8Array(inode.data),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
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

/** Why the host stopped a guest from inside an import. */
type Stop =
  | { kind: "exit"; code: number }
  | { kind: "failure"; error: unknown }
  | { kind: "cancel" };

/**
 * Execute a pinned WASI command in a fresh memory filesystem. `stdin` and
 * `files` are copied into the filesystem unless `copy` is false, which callers
 * pass only for buffers they already own privately.
 *
 * `module` must come from compileBounded: the injected checks poll `control`,
 * and so does every import before it acts, and a stop never throws into the
 * guest (see interrupt.ts). An exit records its status, a budget or host
 * error records its cause, and a cancellation records nothing here; each
 * zeroes the countdown so the guest traps at the check that follows the
 * import call, before any guest handler runs. Once stopped, every import
 * returns EINTR without acting. A cancelled job rejects with Cancelled.
 */
export async function runCommand(
  module: WebAssembly.Module,
  args: string[],
  stdin: Uint8Array,
  files: Record<string, Uint8Array>,
  readonly: boolean,
  limits: ResourceLimits = defaultLimits,
  copy = true,
  control: JobControl = new JobControl(),
): Promise<CommandResult> {
  const root = stageFiles(files, readonly, copy);
  if (!readonly) boundFilesystem(root, limits);
  const requestBound = readonly && limits.requestBytes < limits.stdoutBytes;
  const output = boundedStream(
    requestBound ? limits.requestBytes : limits.stdoutBytes,
    requestBound ? "requestBytes" : "stdoutBytes",
  );
  const errors = boundedStream(limits.stderrBytes, "stderrBytes");
  const argv = [...args];
  const wasi = new WASI(argv, [], [
    new OpenFile(
      copy ? new File(stdin, { readonly: true }) : privateFile(stdin, true),
    ),
    output.descriptor,
    errors.descriptor,
    new PreopenDirectory("/", root.contents),
  ], { debug: false });
  protectFiles(wasi, readonly);

  let stop: Stop | undefined;
  let countdown: WebAssembly.Global | undefined;
  const halt = (reason: Stop) => {
    stop ??= reason;
    if (countdown) countdown.value = 0;
  };

  // poll_oneoff sleeps through the job's control, never past its deadline,
  // and answers EINTR once the job is cancelled; the check following the
  // call then traps.
  correctShimAbi(wasi, argv, control, () => halt({ kind: "cancel" }));
  boundWasiIO(wasi, limits);

  // proc_exit returns to the guest, which traps on the injected unreachable;
  // the shim's WASIProcExit would unwind through guest catch handlers.
  wasi.wasiImport.proc_exit = (code: number) => halt({ kind: "exit", code });
  // Outermost: no host exception reaches guest frames, where catch_all could
  // intercept it; it stops the guest like a trap instead. Each call first
  // polls the job, so a loop of costly calls (random_get over all of memory,
  // say) stops after one of them rather than at the countdown's next expiry.
  const cancel = () => {
    if (!control.cancelled()) return false;
    halt({ kind: "cancel" });
    return true;
  };
  for (const [name, original] of Object.entries(wasi.wasiImport)) {
    wasi.wasiImport[name] = (...values: unknown[]) => {
      if (stop) return ERRNO_INTR;
      try {
        return cancel() ? ERRNO_INTR : original(...values);
      } catch (error) {
        halt({ kind: "failure", error });
        return ERRNO_INTR;
      }
    };
  }
  // The same containment for the poll itself: a signal whose `aborted`
  // throws stops the guest as a host failure.
  const interrupt = () => {
    if (stop) return 1;
    try {
      return cancel() ? 1 : 0;
    } catch (error) {
      halt({ kind: "failure", error });
      return 1;
    }
  };

  let code = 0;
  let failure: { error: unknown } | undefined;
  let generated: Record<string, Uint8Array> = {};
  try {
    const instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: wasi.wasiImport,
      [interruptModule]: { [interruptName]: interrupt },
    });
    const { memory, _start, [countdownExport]: counter } = instance.exports;
    if (
      !(memory instanceof WebAssembly.Memory) || typeof _start !== "function"
    ) {
      throw new Error("WASI command must export memory and _start");
    }
    if (!(counter instanceof WebAssembly.Global)) {
      throw new Error("WASI command was not instrumented for interruption");
    }
    countdown = counter;
    // A stop recorded while a start function ran, before the countdown
    // could be zeroed, is final: _start never runs.
    if (!stop) {
      code = wasi.start({ exports: { memory, _start: () => _start() } });
    }
  } catch (error) {
    // A trap after a stop is the stop itself; any other is the failure.
    if (!stop) failure = { error };
  }
  const stderr = () =>
    new TextDecoder().decode(new Uint8Array(errors.file.data));
  if (stop?.kind === "cancel") throw new Cancelled(control.reason, stderr());
  if (stop?.kind === "failure") failure = { error: stop.error };
  if (stop?.kind === "exit") code = stop.code;
  if (!failure && code === 0 && !readonly) {
    try {
      generated = collectFiles(root, limits);
    } catch (error) {
      failure = { error };
    }
  }
  if (failure) {
    const { error } = failure;
    const text = stderr();
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandError(
      `WASI command failed: ${message}${text ? `\n${text}` : ""}`,
      text,
      error,
    );
  }
  return {
    code,
    stdout: new Uint8Array(output.file.data),
    stderr: stderr(),
    files: generated,
  };
}
