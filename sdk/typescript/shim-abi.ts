/**
 * Corrections to the pinned browser_wasi_shim's WASI ABI, kept outside the
 * reference source: `path_readlink`, `args_sizes_get`, and `poll_oneoff`, and
 * the entry-name check. The SDK runtime and the Deno test host
 * (tests/hosts/deno/main.ts) both apply them, so a fix reaches the shipped
 * adapter and the parity host together.
 */
import {
  CLOCKID_MONOTONIC,
  CLOCKID_REALTIME,
  ERRNO_BADF,
  ERRNO_INTR,
  ERRNO_INVAL,
  ERRNO_NOTDIR,
  ERRNO_NOTSUP,
  EVENTTYPE_CLOCK,
  OpenDirectory,
  SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME,
  type WASI,
} from "./shim.ts";

/** Reject names the in-memory filesystem cannot hold as one path segment. */
export function checkName(name: string): void {
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw new Error(`invalid filesystem entry name: ${JSON.stringify(name)}`);
  }
}

/**
 * How `poll_oneoff` waits: `sleep` blocks for up to `milliseconds` (it may
 * return early), and `cancelled` says whether the job the guest serves was
 * stopped meanwhile. The SDK passes the job's JobControl; the Deno test host
 * passes a clock that is never cancelled.
 */
export interface PollClock {
  sleep(milliseconds: number): void;
  cancelled(): boolean;
}

/**
 * Install the ABI corrections on `wasi`, which was constructed with `argv`:
 *
 * - `path_readlink`: the in-memory filesystem has no symlinks. Zig checks
 *   each output path with readlink before writing; preserve lookup failures
 *   and report INVAL for existing non-links instead of the shim's NOTSUP.
 * - `args_sizes_get`: `args_get` writes UTF-8, whereas the shim's sizing
 *   counts UTF-16 code units, which is too small for non-ASCII arguments.
 * - `poll_oneoff`: the shim busy-waits for the whole interval and reads the
 *   subscription flags at the wrong offset. The replacement serves exactly
 *   one clock subscription (relative or absolute, monotonic or realtime),
 *   sleeps through `clock`, reads the whole subscription before it writes
 *   the event (the two may overlap), and reports one event. When `clock`
 *   reports a cancellation after the sleep, it calls `onCancel` and answers
 *   EINTR instead.
 *   https://github.com/WebAssembly/WASI/blob/main/legacy/preview1/docs.md#poll_oneoff
 */
export function correctShimAbi(
  wasi: WASI,
  argv: readonly string[],
  clock: PollClock,
  onCancel: () => void = () => {},
): void {
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
  wasi.wasiImport.poll_oneoff = (
    input: number,
    output: number,
    count: number,
    events: number,
  ) => {
    const buffer = wasi.inst.exports.memory.buffer;
    input >>>= 0;
    output >>>= 0;
    events >>>= 0;
    // One subscription (48 bytes in) and one event (32 bytes out).
    const subscriptions = count >>> 0;
    if (subscriptions === 0) return ERRNO_INVAL;
    if (subscriptions !== 1) return ERRNO_NOTSUP;
    if (
      input + 48 > buffer.byteLength || output + 32 > buffer.byteLength ||
      events + 4 > buffer.byteLength
    ) return ERRNO_INVAL;
    const view = new DataView(buffer);
    // subscription: userdata u64 @0, tag u8 @8, clock id u32 @16,
    // timeout u64 @24, precision u64 @32, flags u16 @40.
    if (view.getUint8(input + 8) !== EVENTTYPE_CLOCK) return ERRNO_NOTSUP;
    const clockId = view.getUint32(input + 16, true);
    let now: bigint;
    if (clockId === CLOCKID_MONOTONIC) {
      now = BigInt(Math.round(performance.now() * 1_000_000));
    } else if (clockId === CLOCKID_REALTIME) {
      now = BigInt(Date.now()) * 1_000_000n;
    } else return ERRNO_INVAL;
    const userdata = view.getBigUint64(input, true);
    const timeout = view.getBigUint64(input + 24, true);
    const absolute = view.getUint16(input + 40, true) &
      SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME;
    const remaining = absolute ? timeout - now : timeout;
    clock.sleep(remaining > 0n ? Number(remaining) / 1_000_000 : 0);
    if (clock.cancelled()) {
      onCancel();
      return ERRNO_INTR;
    }
    // event: userdata u64 @0, error u16 @8, type u8 @10, 32 bytes in all.
    // The subscription was read in full first: the two may overlap.
    const event = new DataView(wasi.inst.exports.memory.buffer, output, 32);
    for (let offset = 0; offset < 32; offset += 4) event.setUint32(offset, 0);
    event.setBigUint64(0, userdata, true);
    event.setUint8(10, EVENTTYPE_CLOCK);
    new DataView(wasi.inst.exports.memory.buffer).setUint32(events, 1, true);
    return 0;
  };
}
