// The Wasm host matrix and the guest exit-class oracle. A guest diagnostic is
// exit status 1 with guest-authored stderr; a trap, an uncaught exception or a
// host error is a different exit status with runtime text, and must never be
// accepted as a diagnostic.

import { assert } from "./assert.ts";
import { root, wasmBin, wazeroRun } from "./paths.ts";
import { decodeText, describeExit } from "./process.ts";

export interface WasmHost {
  name: string;
  /** Command prefix; `--dir host::/ module.wasm args...` follows. */
  command: readonly string[];
  /** Exit status the host reports for a trap or an uncaught exception. */
  trapExitCode: number;
  /**
   * Host options that publish the guest's files even when it fails. The
   * Deno host exports its in-memory filesystem only on exit 0; Wasmtime and
   * wazero-run write through to the directory and need nothing.
   */
  failureExportArgs: readonly string[];
}

export interface GuestOptions {
  /**
   * Pass the host's `failureExportArgs`, so a negative-path step can assert
   * on every host that a failing guest left no output behind.
   */
  exportOnFailure?: boolean;
}

/** Exit status wazero-run and the Deno host use for traps and host errors. */
export const HOST_TRAP_EXIT_CODE = 70;

/** Wasmtime reports traps as an abort. */
export const WASMTIME_TRAP_EXIT_CODE = 134;

export const wasmHosts: readonly WasmHost[] = [
  {
    name: "wasmtime",
    command: ["wasmtime", "run", "-W", "exceptions=y"],
    trapExitCode: WASMTIME_TRAP_EXIT_CODE,
    failureExportArgs: [],
  },
  {
    name: "wazero",
    command: [wazeroRun],
    trapExitCode: HOST_TRAP_EXIT_CODE,
    failureExportArgs: [],
  },
  {
    name: "wazero-interpreter",
    command: [wazeroRun, "--interpreter"],
    trapExitCode: HOST_TRAP_EXIT_CODE,
    failureExportArgs: [],
  },
  {
    name: "deno",
    command: [
      "deno",
      "run",
      "--unstable-sloppy-imports",
      "--allow-read",
      "--allow-write",
      "--config",
      `${root}/tests/hosts/deno/deno.json`,
      `${root}/tests/hosts/deno/main.ts`,
    ],
    trapExitCode: HOST_TRAP_EXIT_CODE,
    failureExportArgs: ["--export-always"],
  },
];

/**
 * The command line that runs any module on a host with `directory` as `/`
 * and `argv0` as the guest's program name. wazero-run and the Deno host
 * derive argv[0] from the module file name, and Wasmtime needs --argv0.
 */
export function moduleCommand(
  host: WasmHost,
  modulePath: string,
  argv0: string,
  directory: string,
  args: readonly string[] = [],
  options: GuestOptions = {},
): string[] {
  return [
    ...host.command,
    ...(host.name === "wasmtime" ? ["--argv0", argv0] : []),
    ...(options.exportOnFailure ? host.failureExportArgs : []),
    "--dir",
    `${directory}::/`,
    modulePath,
    ...args,
  ];
}

/**
 * The command line that runs `tool.wasm` on a host with `directory` as `/`.
 * Every host presents the tool name as the guest's argv[0], as the SDKs do.
 */
export function guestCommand(
  host: WasmHost,
  tool: string,
  directory: string,
  args: readonly string[] = [],
  options: GuestOptions = {},
): string[] {
  return moduleCommand(
    host,
    `${wasmBin}/${tool}.wasm`,
    tool,
    directory,
    args,
    options,
  );
}

/**
 * A minimal WASI command module that traps at once, for exercising the hosts'
 * trap exit status. Source (wasm-tools parse):
 *
 *   (module (memory (export "memory") 1) (func (export "_start") unreachable))
 */
export const TRAP_GUEST = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00, // magic, version
  0x01,
  0x04,
  0x01,
  0x60,
  0x00,
  0x00, // type: () -> ()
  0x03,
  0x02,
  0x01,
  0x00, // function 0 has type 0
  0x05,
  0x03,
  0x01,
  0x00,
  0x01, // memory: 1 page, no maximum
  0x07,
  0x13,
  0x02, // exports: 2
  0x06,
  0x6d,
  0x65,
  0x6d,
  0x6f,
  0x72,
  0x79,
  0x02,
  0x00, // "memory" memory 0
  0x06,
  0x5f,
  0x73,
  0x74,
  0x61,
  0x72,
  0x74,
  0x00,
  0x00, // "_start" func 0
  0x0a,
  0x05,
  0x01,
  0x03,
  0x00,
  0x00,
  0x0b, // code: unreachable; end
]);

/**
 * Text that only a runtime writes when a guest traps, throws an uncaught
 * exception, or fails to start. `*** Uncaught exception ***` is not listed: KJ
 * prints it for exceptions that its own main caught, which exit 1.
 */
export const TRAP_TEXT =
  /wasm trap|wasm error|failed to run main module|^wazero-run:|^deno-wasi-run:|unreachable|terminating due to uncaught|RuntimeError/m;

/**
 * Asserts a guest diagnostic: exit status 1 exactly, no signal, empty stdout,
 * non-empty stderr without runtime trap text.
 */
export function assertGuestDiagnostic(
  result: Deno.CommandOutput,
  label: string,
): string {
  const stderr = decodeText(result.stderr);
  assert(
    result.signal === null && result.code === 1,
    `${label}: expected a diagnostic (exit 1) but the guest ${
      describeExit(result)
    }; stderr:\n${stderr}`,
  );
  assert(result.stdout.length === 0, `${label} wrote stdout despite failure`);
  assert(stderr.length > 0, `${label} produced no diagnostic`);
  const trap = TRAP_TEXT.exec(stderr);
  assert(
    trap === null,
    `${label}: stderr contains runtime trap text ${
      JSON.stringify(trap?.[0])
    } instead of a guest diagnostic:\n${stderr}`,
  );
  return stderr;
}
