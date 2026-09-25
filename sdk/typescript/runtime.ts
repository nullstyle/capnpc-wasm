import {
  boundedStream,
  boundFilesystem,
  boundWasiIO,
  LimitError,
} from "./resource-fs.ts";
import { checkPath } from "./limits.ts";
import {
  Cancelled,
  countdownExport,
  interruptModule,
  interruptName,
  JobControl,
} from "./interrupt.ts";
import { defaultLimits, type ResourceLimits } from "./types.ts";
import {
  CLOCKID_MONOTONIC,
  CLOCKID_REALTIME,
  Directory,
  ERRNO_BADF,
  ERRNO_INTR,
  ERRNO_INVAL,
  ERRNO_NOTDIR,
  ERRNO_NOTSUP,
  ERRNO_ROFS,
  EVENTTYPE_CLOCK,
  File,
  OFLAGS_CREAT,
  OFLAGS_TRUNC,
  OpenDirectory,
  OpenFile,
  PreopenDirectory,
  SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME,
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

function checkName(name: string): void {
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw new Error(`invalid filesystem entry name: ${JSON.stringify(name)}`);
  }
}

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
 * `poll_oneoff` for the single clock subscription the pinned shim supports
 * (boundWasiIO checks the count and the subscription and event pointers).
 * The shim busy-waits for the whole interval and reads the subscription
 * flags at the wrong offset; this sleeps through JobControl instead, never
 * past the job deadline, and answers EINTR when the job was cancelled, after
 * which the check following the call traps.
 * https://github.com/WebAssembly/WASI/blob/main/legacy/preview1/docs.md#poll_oneoff
 */
function clockPoll(
  wasi: WASI,
  control: JobControl,
  cancel: () => void,
): (input: number, output: number, count: number, events: number) => number {
  return (input, output, _count, events) => {
    const buffer = wasi.inst.exports.memory.buffer;
    input >>>= 0;
    output >>>= 0;
    events >>>= 0;
    if (events + 4 > buffer.byteLength) return ERRNO_INVAL;
    const view = new DataView(buffer);
    // subscription: userdata u64 @0, tag u8 @8, clock id u32 @16,
    // timeout u64 @24, precision u64 @32, flags u16 @40.
    if (view.getUint8(input + 8) !== EVENTTYPE_CLOCK) return ERRNO_NOTSUP;
    const clock = view.getUint32(input + 16, true);
    let now: bigint;
    if (clock === CLOCKID_MONOTONIC) {
      now = BigInt(Math.round(performance.now() * 1_000_000));
    } else if (clock === CLOCKID_REALTIME) {
      now = BigInt(Date.now()) * 1_000_000n;
    } else return ERRNO_INVAL;
    const timeout = view.getBigUint64(input + 24, true);
    const absolute = view.getUint16(input + 40, true) &
      SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME;
    const remaining = absolute ? timeout - now : timeout;
    control.sleep(remaining > 0n ? Number(remaining) / 1_000_000 : 0);
    if (control.cancelled()) {
      cancel();
      return ERRNO_INTR;
    }
    // event: userdata u64 @0, error u16 @8, type u8 @10, 32 bytes in all.
    const event = new DataView(wasi.inst.exports.memory.buffer, output, 32);
    for (let offset = 0; offset < 32; offset += 4) event.setUint32(offset, 0);
    event.setBigUint64(0, view.getBigUint64(input, true), true);
    event.setUint8(10, EVENTTYPE_CLOCK);
    new DataView(wasi.inst.exports.memory.buffer).setUint32(events, 1, true);
    return 0;
  };
}

/**
 * Execute a pinned WASI command in a fresh memory filesystem. `stdin` and
 * `files` are copied into the filesystem unless `copy` is false, which callers
 * pass only for buffers they already own privately.
 *
 * `module` must come from compileBounded: the injected checks poll `control`,
 * and a stop never throws into the guest (see interrupt.ts). An exit records
 * its status, a budget or host error records its cause, and a cancellation
 * records nothing here; each zeroes the countdown so the guest traps at its
 * next check, before any guest handler runs. Once stopped, every import
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

  wasi.wasiImport.poll_oneoff = clockPoll(
    wasi,
    control,
    () => halt({ kind: "cancel" }),
  );
  boundWasiIO(wasi, limits);

  // proc_exit returns to the guest, which traps on the injected unreachable;
  // the shim's WASIProcExit would unwind through guest catch handlers.
  wasi.wasiImport.proc_exit = (code: number) => halt({ kind: "exit", code });
  // Outermost: no host exception reaches guest frames, where catch_all could
  // intercept it; it stops the guest like a trap instead.
  for (const [name, original] of Object.entries(wasi.wasiImport)) {
    wasi.wasiImport[name] = (...values: unknown[]) => {
      if (stop) return ERRNO_INTR;
      try {
        return original(...values);
      } catch (error) {
        halt({ kind: "failure", error });
        return ERRNO_INTR;
      }
    };
  }
  const interrupt = () => {
    if (stop) return 1;
    if (!control.cancelled()) return 0;
    halt({ kind: "cancel" });
    return 1;
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
    if (stop) countdown.value = 0;
    code = wasi.start({ exports: { memory, _start: () => _start() } });
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
