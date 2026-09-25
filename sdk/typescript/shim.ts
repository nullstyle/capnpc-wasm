/**
 * The pinned browser_wasi_shim (ref/browser_wasi_shim), imported only here.
 * Each `@ts-types` hint gives the type checker shim.d.ts, the part of the
 * shim's API the SDK uses, in place of the upstream sources, which are not
 * strict-clean; the bundler and runtime still load the real modules.
 *
 * `deno check` honors the hints, so deno.strict.json checks the SDK and its
 * tests in strict mode. `deno test` and `deno run` type-check every local
 * module they load, the shim's sources included, so deno.json, which the
 * test tasks and the bundler use, stays non-strict.
 */

// @ts-types="./shim.d.ts"
export { default as WASI } from "../../ref/browser_wasi_shim/src/wasi.ts";
// @ts-types="./shim.d.ts"
export {
  Directory,
  File,
  OpenDirectory,
  OpenFile,
  PreopenDirectory,
} from "../../ref/browser_wasi_shim/src/fs_mem.ts";
// @ts-types="./shim.d.ts"
export type { Fd, Inode } from "../../ref/browser_wasi_shim/src/fd.ts";
// @ts-types="./shim.d.ts"
export {
  CLOCKID_MONOTONIC,
  CLOCKID_REALTIME,
  ERRNO_BADF,
  ERRNO_INTR,
  ERRNO_INVAL,
  ERRNO_NFILE,
  ERRNO_NOTDIR,
  ERRNO_NOTSUP,
  ERRNO_ROFS,
  EVENTTYPE_CLOCK,
  OFLAGS_CREAT,
  OFLAGS_TRUNC,
  SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME,
} from "../../ref/browser_wasi_shim/src/wasi_defs.ts";
