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
  },
  {
    name: "wazero",
    command: [wazeroRun],
    trapExitCode: HOST_TRAP_EXIT_CODE,
  },
  {
    name: "wazero-interpreter",
    command: [wazeroRun, "--interpreter"],
    trapExitCode: HOST_TRAP_EXIT_CODE,
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
  },
];

/**
 * The command line that runs `tool.wasm` on a host with `directory` as `/`.
 * Every host presents the tool name as the guest's argv[0], as the SDKs and
 * the launcher do; wazero-run and the Deno host derive it from the module
 * name, and Wasmtime needs --argv0.
 */
export function guestCommand(
  host: WasmHost,
  tool: string,
  directory: string,
  args: readonly string[] = [],
): string[] {
  return [
    ...host.command,
    ...(host.name === "wasmtime" ? ["--argv0", tool] : []),
    "--dir",
    `${directory}::/`,
    `${wasmBin}/${tool}.wasm`,
    ...args,
  ];
}

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
