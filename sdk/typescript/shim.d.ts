/**
 * Declarations for the parts of the pinned browser_wasi_shim
 * (ref/browser_wasi_shim/src) that the SDK uses. shim.ts attaches them to the
 * real modules with `@ts-types`, so the SDK type-checks under strict mode
 * without checking the upstream sources, which are not strict-clean.
 *
 * Signatures mirror the upstream ones at the recorded gitlink. A result the
 * SDK never reads is declared as a wider type (`object`), never a narrower
 * one. Update this file with every browser_wasi_shim bump.
 */

export declare abstract class Fd {
  fd_allocate(offset: bigint, len: bigint): number;
  fd_close(): number;
  fd_filestat_set_size(size: bigint): number;
  fd_pread(size: number, offset: bigint): { ret: number; data: Uint8Array };
  fd_pwrite(
    data: Uint8Array,
    offset: bigint,
  ): { ret: number; nwritten: number };
  fd_read(size: number): { ret: number; data: Uint8Array };
  fd_write(data: Uint8Array): { ret: number; nwritten: number };
  path_filestat_get(
    flags: number,
    path: string,
  ): { ret: number; filestat: object | null };
}

export declare abstract class Inode {
  ino: bigint;
  path_open(
    oflags: number,
    fs_rights_base: bigint,
    fd_flags: number,
  ): { ret: number; fd_obj: Fd | null };
}

export declare class File extends Inode {
  data: Uint8Array;
  readonly: boolean;
  constructor(
    data: ArrayBufferLike | ArrayLike<number>,
    options?: Partial<{ readonly: boolean }>,
  );
  get size(): bigint;
}

export declare class Directory extends Inode {
  contents: Map<string, Inode>;
  parent: Directory | null;
  constructor(contents: Map<string, Inode> | [string, Inode][]);
}

export declare class OpenFile extends Fd {
  file: File;
  file_pos: bigint;
  constructor(file: File);
}

export declare class OpenDirectory extends Fd {
  dir: Directory;
  constructor(dir: Directory);
}

export declare class PreopenDirectory extends OpenDirectory {
  prestat_name: string;
  constructor(name: string, contents: Map<string, Inode>);
}

export default class WASI {
  args: string[];
  env: string[];
  fds: Fd[];
  inst: { exports: { memory: WebAssembly.Memory } };
  // deno-lint-ignore no-explicit-any
  wasiImport: { [key: string]: (...args: any[]) => unknown };
  constructor(
    args: string[],
    env: string[],
    fds: Fd[],
    options?: { debug?: boolean },
  );
  /** Runs `_start`; returns 0, or the code of a thrown WASIProcExit. */
  start(instance: {
    exports: { memory: WebAssembly.Memory; _start: () => unknown };
  }): number;
}

export declare const CLOCKID_REALTIME: 0;
export declare const CLOCKID_MONOTONIC: 1;
export declare const ERRNO_BADF: 8;
export declare const ERRNO_INTR: 27;
export declare const ERRNO_INVAL: 28;
export declare const ERRNO_NFILE: 41;
export declare const ERRNO_NOTDIR: 54;
export declare const ERRNO_NOTSUP: 58;
export declare const ERRNO_ROFS: 69;
export declare const EVENTTYPE_CLOCK: 0;
export declare const OFLAGS_CREAT: number;
export declare const OFLAGS_TRUNC: number;
export declare const SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME: number;
