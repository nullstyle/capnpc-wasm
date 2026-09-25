import {
  Directory,
  ERRNO_BADF,
  ERRNO_INVAL,
  ERRNO_NFILE,
  ERRNO_NOTSUP,
  File,
  type Inode,
  OpenFile,
  type WASI,
} from "./shim.ts";
import type { ResourceLimits } from "./types.ts";

/**
 * A guest exceeded one of the host budgets in ResourceLimits. Thrown inside a
 * WASI import, it never reaches the guest: runCommand catches it at the import
 * boundary and the guest traps at its next check (see interrupt.ts), so no
 * guest handler runs. The engine reports a CompileError naming the limit.
 */
export class LimitError extends Error {
  override readonly name = "LimitError";
  constructor(public readonly limit: keyof ResourceLimits) {
    super(`${limit} resource limit exceeded`);
  }
}

/**
 * Live descriptors a command may hold at once. The pinned shim keeps every
 * opened descriptor in a host array, so without a ceiling a guest that never
 * closes grows host memory with its CPU time, outside every byte budget. The
 * compiler and generators hold a handful at a time; this is not a public knob.
 */
export const maximumDescriptors = 1024;

class ByteBudget {
  used = 0;
  constructor(readonly maximum: number, readonly name: keyof ResourceLimits) {}
  check(file: File, size: bigint): void {
    if (
      size < 0n || size > BigInt(this.maximum - this.used + file.data.length)
    ) {
      throw new LimitError(this.name);
    }
  }
  attach(file: File): void {
    let data = file.data;
    // The shim may resize data.buffer in place before assigning file.data.
    // Keep the charged size separately: data.length already reflects that new
    // size by the time the setter runs, even when value === data.
    let charged = data.length;
    this.used += charged;
    Object.defineProperty(file, "data", {
      get: () => data,
      set: (value: Uint8Array) => {
        this.used += value.length - charged;
        charged = value.length;
        data = value;
      },
    });
    const guard = (descriptor: OpenFile) => {
      const allocate = descriptor.fd_allocate.bind(descriptor);
      descriptor.fd_allocate = (offset, length) => {
        this.check(
          file,
          offset + length > file.size ? offset + length : file.size,
        );
        return allocate(offset, length);
      };
      const resize = descriptor.fd_filestat_set_size.bind(descriptor);
      descriptor.fd_filestat_set_size = (size) => {
        this.check(file, size);
        return resize(size);
      };
      const write = descriptor.fd_write.bind(descriptor);
      descriptor.fd_write = (data) => {
        const end = descriptor.file_pos + BigInt(data.length);
        this.check(file, end > file.size ? end : file.size);
        return write(data);
      };
      const pwrite = descriptor.fd_pwrite.bind(descriptor);
      descriptor.fd_pwrite = (data, offset) => {
        const end = offset + BigInt(data.length);
        this.check(file, end > file.size ? end : file.size);
        return pwrite(data, offset);
      };
      return descriptor;
    };
    const open = file.path_open.bind(file);
    file.path_open = (...args) => {
      const result = open(...args);
      if (result.fd_obj instanceof OpenFile) guard(result.fd_obj);
      return result;
    };
  }
}

/** Account retained writable inodes, including unlinked files still held by fds. */
export function boundFilesystem(root: Directory, limits: ResourceLimits): void {
  const budget = new ByteBudget(limits.outputBytes, "outputBytes");
  const retained = new Set<Inode>();
  let entries = 0;
  function attach(inode: Inode): void {
    if (retained.has(inode)) return;
    retained.add(inode);
    if (inode instanceof File) budget.attach(inode);
    else if (inode instanceof Directory) {
      const contents = inode.contents;
      const set = contents.set.bind(contents);
      contents.set = (name, child) => {
        // A lifetime creation budget also bounds unlink/recreate churn and
        // retained descriptors. Existing-name replacements do not add an entry.
        if (!contents.has(name) && ++entries > limits.outputEntries) {
          throw new LimitError("outputEntries");
        }
        attach(child);
        return set(name, child);
      };
      for (const child of contents.values()) attach(child);
    }
  }
  attach(root);
}

export function boundedStream(
  maximum: number,
  name: keyof ResourceLimits,
): { file: File; descriptor: OpenFile } {
  const file = new File([]);
  new ByteBudget(maximum, name).attach(file);
  return { file, descriptor: file.path_open(0, 0n, 0).fd_obj as OpenFile };
}

/**
 * Replace the upstream shim's imports whose host work is sized by guest
 * arguments. Pointers and counts are checked against guest memory before any
 * allocation, so a one-page guest cannot make the host allocate more than a
 * page: no iovec arrays, no temporary random buffers, no pre-budget copies.
 * Out-of-range arguments return EINVAL to the guest instead of trapping.
 */
export function boundWasiIO(wasi: WASI, limits: ResourceLimits): void {
  const memory = () => new Uint8Array(wasi.inst.exports.memory.buffer);
  const write = (
    fd: number,
    pointer: number,
    count: number,
    result: number,
    offset?: bigint,
  ): number => {
    const descriptor = wasi.fds[fd];
    if (!descriptor) return ERRNO_BADF;
    const bytes = memory();
    const view = new DataView(bytes.buffer);
    pointer >>>= 0;
    count >>>= 0;
    result >>>= 0;
    if (pointer + count * 8 > bytes.length || result + 4 > bytes.length) {
      return ERRNO_INVAL;
    }
    let written = 0;
    for (let index = 0; index < count; index++) {
      const address = view.getUint32(pointer + index * 8, true);
      const length = view.getUint32(pointer + index * 8 + 4, true);
      if (address + length > bytes.length) return ERRNO_INVAL;
      const data = bytes.subarray(address, address + length);
      const part = offset === undefined
        ? descriptor.fd_write(data)
        : descriptor.fd_pwrite(data, offset);
      written += part.nwritten;
      view.setUint32(result, written, true);
      if (part.ret || part.nwritten !== length) return part.ret;
      if (offset !== undefined) offset += BigInt(part.nwritten);
    }
    view.setUint32(result, written, true);
    return 0;
  };
  wasi.wasiImport.fd_write = (
    fd: number,
    pointer: number,
    count: number,
    result: number,
  ) => write(fd, pointer, count, result);
  wasi.wasiImport.fd_pwrite = (
    fd: number,
    pointer: number,
    count: number,
    offset: bigint,
    result: number,
  ) => write(fd, pointer, count, result, offset);

  // Reads stream each iovec straight into guest memory. The shim's descriptor
  // reads copy at most the remaining file bytes, which the input budgets
  // already bound.
  const read = (
    fd: number,
    pointer: number,
    count: number,
    result: number,
    offset?: bigint,
  ): number => {
    const descriptor = wasi.fds[fd];
    if (!descriptor) return ERRNO_BADF;
    const bytes = memory();
    const view = new DataView(bytes.buffer);
    pointer >>>= 0;
    count >>>= 0;
    result >>>= 0;
    if (pointer + count * 8 > bytes.length || result + 4 > bytes.length) {
      return ERRNO_INVAL;
    }
    let total = 0;
    for (let index = 0; index < count; index++) {
      const address = view.getUint32(pointer + index * 8, true);
      const length = view.getUint32(pointer + index * 8 + 4, true);
      if (address + length > bytes.length) return ERRNO_INVAL;
      const part = offset === undefined
        ? descriptor.fd_read(length)
        : descriptor.fd_pread(length, offset);
      if (part.ret) {
        view.setUint32(result, total, true);
        return part.ret;
      }
      bytes.set(part.data, address);
      total += part.data.length;
      if (offset !== undefined) offset += BigInt(part.data.length);
      if (part.data.length !== length) break;
    }
    view.setUint32(result, total, true);
    return 0;
  };
  wasi.wasiImport.fd_read = (
    fd: number,
    pointer: number,
    count: number,
    result: number,
  ) => read(fd, pointer, count, result);
  wasi.wasiImport.fd_pread = (
    fd: number,
    pointer: number,
    count: number,
    offset: bigint,
    result: number,
  ) => read(fd, pointer, count, result, offset);

  // Fill guest memory in place; getRandomValues accepts at most 64 KiB per call.
  wasi.wasiImport.random_get = (buffer: number, length: number) => {
    const bytes = memory();
    buffer >>>= 0;
    length >>>= 0;
    if (buffer + length > bytes.length) return ERRNO_INVAL;
    for (let filled = 0; filled < length; filled += 65536) {
      crypto.getRandomValues(
        bytes.subarray(
          buffer + filled,
          buffer + Math.min(length, filled + 65536),
        ),
      );
    }
    return 0;
  };

  // The remaining guest-sized imports only copy existing host data, but they
  // write at guest pointers: reject ranges outside memory before the shim can.
  const readdir = wasi.wasiImport.fd_readdir;
  wasi.wasiImport.fd_readdir = (
    fd: number,
    buffer: number,
    length: number,
    cookie: bigint,
    used: number,
  ) => {
    const size = memory().length;
    if ((buffer >>> 0) + (length >>> 0) > size || (used >>> 0) + 4 > size) {
      return ERRNO_INVAL;
    }
    return readdir(fd, buffer, length, cookie, used);
  };
  const prestatName = wasi.wasiImport.fd_prestat_dir_name;
  wasi.wasiImport.fd_prestat_dir_name = (
    fd: number,
    pointer: number,
    length: number,
  ) => {
    if ((pointer >>> 0) + (length >>> 0) > memory().length) return ERRNO_INVAL;
    return prestatName(fd, pointer, length);
  };
  const poll = wasi.wasiImport.poll_oneoff;
  wasi.wasiImport.poll_oneoff = (
    input: number,
    output: number,
    count: number,
    ...rest: unknown[]
  ) => {
    // The clock poll (shim-abi.ts), like the shim, serves exactly one clock
    // subscription (48 bytes in, 32 bytes out) and checks the same again.
    // Treat the count as the unsigned value the guest passed, so a negative
    // i32 cannot slip past these checks to a raw read.
    const subscriptions = count >>> 0;
    if (subscriptions === 0) return ERRNO_INVAL;
    if (subscriptions !== 1) return ERRNO_NOTSUP;
    const size = memory().length;
    if ((input >>> 0) + 48 > size || (output >>> 0) + 32 > size) {
      return ERRNO_INVAL;
    }
    return poll(input, output, 1, ...rest);
  };

  // Bound guest path copies while allowing /include mount prefixes and the
  // reference runtime's /dev/.. root probe. User workspace/output paths still
  // pass exact pathBytes checks before input copies and output publication.
  const guestPathBytes = limits.pathBytes + 8;
  const paths: Record<string, number[]> = {
    path_create_directory: [2],
    path_filestat_get: [3],
    path_filestat_set_times: [3],
    path_link: [3, 6],
    path_open: [3],
    path_readlink: [2],
    path_remove_directory: [2],
    path_rename: [2, 5],
    path_symlink: [1, 4],
    path_unlink_file: [2],
  };
  for (const [name, positions] of Object.entries(paths)) {
    const original = wasi.wasiImport[name];
    wasi.wasiImport[name] = (...args: unknown[]) => {
      for (const position of positions) {
        if (((args[position] as number) >>> 0) > guestPathBytes) {
          throw new LimitError("pathBytes");
        }
      }
      return original(...args);
    };
  }

  // Cap live descriptors. path_open is the only import that adds one; close
  // and renumber are the only ones that release slots. The shim retains a
  // new descriptor before it writes the fd number, so the result pointer is
  // checked here first: a guest cannot make that write throw after the push
  // and catch the exception to keep opening. Should the shim still throw, the
  // count is rebuilt from its table rather than left stale.
  const countLive = () =>
    wasi.fds.filter((descriptor) => descriptor !== undefined).length;
  let live = countLive();
  const open = wasi.wasiImport.path_open;
  wasi.wasiImport.path_open = (...args: unknown[]) => {
    if (((args[8] as number) >>> 0) + 4 > memory().length) return ERRNO_INVAL;
    if (live >= maximumDescriptors) return ERRNO_NFILE;
    let ret: unknown;
    try {
      ret = open(...args);
    } catch (cause) {
      live = countLive();
      throw cause;
    }
    if (ret === 0) live++;
    return ret;
  };
  for (const name of ["fd_close", "fd_renumber"]) {
    const original = wasi.wasiImport[name];
    wasi.wasiImport[name] = (fd: number, ...args: unknown[]) => {
      const held = wasi.fds[fd] !== undefined;
      let ret: unknown;
      try {
        ret = original(fd, ...args);
      } catch (cause) {
        live = countLive();
        throw cause;
      }
      if (held && wasi.fds[fd] === undefined && live > 0) live--;
      return ret;
    };
  }
}
