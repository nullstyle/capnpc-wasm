import {
  Directory,
  File,
  OpenFile,
} from "../../ref/browser_wasi_shim/src/fs_mem.ts";
import type { Inode } from "../../ref/browser_wasi_shim/src/fd.ts";
import type WASI from "../../ref/browser_wasi_shim/src/wasi.ts";
import {
  ERRNO_BADF,
  ERRNO_INVAL,
} from "../../ref/browser_wasi_shim/src/wasi_defs.ts";
import type { ResourceLimits } from "./types.ts";

class ByteBudget {
  used = 0;
  constructor(readonly maximum: number, readonly name: string) {}
  check(file: File, size: bigint): void {
    if (
      size < 0n || size > BigInt(this.maximum - this.used + file.data.length)
    ) {
      throw new Error(`${this.name} resource limit exceeded`);
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
          throw new Error("outputEntries resource limit exceeded");
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
  name: string,
): { file: File; descriptor: OpenFile } {
  const file = new File([]);
  new ByteBudget(maximum, name).attach(file);
  return { file, descriptor: file.path_open(0, 0n, 0).fd_obj as OpenFile };
}

/** Avoid the upstream shim's unbounded iovec array and pre-budget byte copies. */
export function boundWasiIO(wasi: WASI, limits: ResourceLimits): void {
  const write = (
    fd: number,
    pointer: number,
    count: number,
    result: number,
    offset?: bigint,
  ): number => {
    const descriptor = wasi.fds[fd];
    if (!descriptor) return ERRNO_BADF;
    const bytes = new Uint8Array(wasi.inst.exports.memory.buffer);
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
          throw new Error("pathBytes resource limit exceeded");
        }
      }
      return original(...args);
    };
  }
}
