// Repository layout shared by the Deno test suites. Every suite runs from the
// repository root (mise.toml runs `deno test` there), so Deno.cwd() is the root.

export const root = Deno.cwd();

/** Pristine native reference tools and the test oracle (`mise run build:native`). */
export const nativeBin = `${root}/build/native/bin`;

/** WASI Preview 1 command modules (`mise run build:wasm` and the generator builds). */
export const wasmBin = `${root}/build/wasm/bin`;

/** The wazero development host (`mise run build:wazero`). */
export const wazeroRun = `${root}/build/hosts/wazero-run`;

/** Disposable per-run work directories; see workdir.ts for retention. */
export const buildTest = `${root}/build/test`;

/**
 * The single Zig local cache for every suite. build-zig.sh and the Zig unit
 * test task use the same directory, so compiled std and runtime objects are
 * shared instead of duplicated under .cache/zig-local.
 */
export const zigCacheDir = `${root}/build/zig/cache`;

/** The prepared, pristine capnp-zig runtime sources (`mise run build:zig`). */
export const zigRuntime = `${root}/build/src/capnp-zig/src`;
