// Subprocess helpers shared by the Deno test suites: one spawn path with piped
// or file stdin, a timeout, BrokenPipe tolerance, and a minimal child
// environment built from one pass-through list.

import { root } from "./paths.ts";

/**
 * Host environment variables that child processes receive. Everything else is
 * dropped, so a developer's RUSTFLAGS, CARGO_* or GOFLAGS settings cannot
 * change what the consumer steps compile. Keep this list equal to
 * `[vars].suite_env` in mise.toml, which the seven suite tasks pass as their
 * `--allow-env` list.
 *
 * PATH, HOME and TMPDIR are what the pinned tools need to run at all. CC and
 * CXX select the native compiler; SDKROOT, LDFLAGS and the host triple's
 * CARGO_TARGET_*_RUSTFLAGS are what scripts/lib/toolchain-env.sh exports when
 * the default macOS SDK cannot link (see ldflags() for the LDFLAGS caveat).
 * The remaining names are the mise `[env]` cache locations plus the Rust
 * toolchain selection: the rustup proxy in CARGO_HOME resolves the pinned
 * toolchain only through RUSTUP_TOOLCHAIN.
 */
export const ENV_PASSTHROUGH: readonly string[] = [
  "CAPNP_KEEP_TEST_DIRS",
  "PATH",
  "HOME",
  "TMPDIR",
  "CC",
  "CXX",
  "SDKROOT",
  "LDFLAGS",
  "CARGO_TARGET_DIR",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "RUSTUP_TOOLCHAIN",
  "CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS",
  "CARGO_TARGET_X86_64_APPLE_DARWIN_RUSTFLAGS",
  "DENO_DIR",
  "GOPATH",
  "GOCACHE",
  "GOTOOLCHAIN",
  "GOFLAGS",
  "GOPROXY",
  "ZIG_GLOBAL_CACHE_DIR",
];

/** Whether this process may read the named environment variable. */
export function envGranted(name: string): boolean {
  return Deno.permissions.querySync({ name: "env", variable: name }).state ===
    "granted";
}

/** Reads a variable when permitted, without triggering a permission prompt. */
export function envValue(name: string): string | undefined {
  return envGranted(name) ? Deno.env.get(name) : undefined;
}

/**
 * Linker flags from LDFLAGS, whitespace-split and empty when unset. clang
 * never reads the variable itself, and scripts/lib/toolchain-env.sh exports
 * `-fuse-ld=<path>` through it in its fallback mode, so every direct clang++
 * link the suites run must splice these flags into its argv (see clangxx in
 * oracle.ts). Cargo and CMake read their own variables.
 */
export function ldflags(): string[] {
  return (envValue("LDFLAGS") ?? "").split(/\s+/).filter((flag) =>
    flag.length > 0
  );
}

let passthrough: Record<string, string> | null | undefined;

/**
 * The environment options for a child process: the pass-through variables
 * plus explicit additions. When the suite runs without `--allow-env` for the
 * whole list, children inherit the full environment and a warning says so once;
 * the mise tasks grant the list, so that fallback is for ad-hoc invocations.
 */
export function childEnv(
  extra: Record<string, string> = {},
): { clearEnv: boolean; env: Record<string, string> } {
  if (passthrough === undefined) {
    const missing = ENV_PASSTHROUGH.filter((name) => !envGranted(name));
    if (missing.length > 0) {
      console.warn(
        `tests/lib/process: no --allow-env for ${
          missing.join(", ")
        }; child processes inherit the full environment`,
      );
      passthrough = null;
    } else {
      passthrough = {};
      for (const name of ENV_PASSTHROUGH) {
        const value = Deno.env.get(name);
        if (value !== undefined) passthrough[name] = value;
      }
    }
  }
  return passthrough === null
    ? { clearEnv: false, env: extra }
    : { clearEnv: true, env: { ...passthrough, ...extra } };
}

export interface RunOptions {
  /** Bytes piped to stdin. Without `stdin` and `stdinFile`, stdin is null. */
  stdin?: Uint8Array;
  /**
   * A regular file opened as stdin through `sh`, for hosts whose stdin
   * handling differs between pipes and files.
   */
  stdinFile?: string;
  /** Working directory; defaults to the repository root. */
  cwd?: string;
  /** Additions to the pass-through environment. */
  env?: Record<string, string>;
  /**
   * After this many milliseconds the direct child receives SIGTERM (and
   * SIGKILL `killAfterMs` later if it is still running). Once it has exited,
   * stdout and stderr are no longer awaited, so a grandchild that inherited
   * the pipes (a `cargo test` or `zig test` binary, say) cannot hold the call
   * open; the output captured until then is returned with `timedOut` set.
   * Defaults to 60 s.
   */
  timeoutMs?: number;
  /** Grace between SIGTERM and SIGKILL after a timeout; defaults to 5 s. */
  killAfterMs?: number;
}

/** A command's output; `timedOut` marks a run that hit `timeoutMs`. */
export interface RunResult extends Deno.CommandOutput {
  timedOut: boolean;
}

/** Runs a command to completion with captured binary stdout and stderr. */
export async function run(
  command: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const {
    stdin,
    stdinFile,
    cwd = root,
    env = {},
    timeoutMs = 60_000,
    killAfterMs = 5_000,
  } = options;
  if (stdin && stdinFile) {
    throw new Error("run: stdin and stdinFile are mutually exclusive");
  }
  const argv = stdinFile
    ? ["sh", "-c", 'exec "$@" < "$0"', stdinFile, ...command]
    : [...command];
  const controller = new AbortController();
  let timedOut = false;
  let exited = false;
  let stopReading!: () => void;
  const stop = new Promise<void>((resolve) => stopReading = resolve);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    // The child may have exited already while a grandchild holds the pipes.
    if (exited) stopReading();
  }, timeoutMs);
  const child = new Deno.Command(argv[0], {
    args: argv.slice(1),
    cwd,
    ...childEnv(env),
    stdin: stdin ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
    signal: controller.signal,
  }).spawn();
  const stdoutBytes = collect(child.stdout, stop);
  const stderrBytes = collect(child.stderr, stop);
  // Arm the SIGKILL escalation before writing stdin: a child that ignores
  // SIGTERM and stops reading would otherwise block the write, and the run,
  // forever.
  const exit = waitForExit(child, controller.signal, killAfterMs);
  try {
    if (stdin) {
      const writer = child.stdin.getWriter();
      try {
        await writer.write(stdin);
        await writer.close();
      } catch (error) {
        // A child that exits before reading all of stdin still reports its own
        // diagnostic; the broken pipe is not the failure of interest.
        if (!(error instanceof Deno.errors.BrokenPipe)) throw error;
      } finally {
        writer.releaseLock();
      }
    }
    const status = await exit;
    exited = true;
    if (timedOut) stopReading();
    return {
      ...status,
      stdout: await stdoutBytes,
      stderr: await stderrBytes,
      timedOut,
    };
  } finally {
    clearTimeout(timer);
    stopReading();
  }
}

/** Resolves the child's status, sending SIGKILL if SIGTERM was ignored. */
async function waitForExit(
  child: Deno.ChildProcess,
  signal: AbortSignal,
  killAfterMs: number,
): Promise<Deno.CommandStatus> {
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let escalateNow!: () => void;
  const escalate = new Promise<"kill">((resolve) => {
    escalateNow = () => resolve("kill");
  });
  const arm = () => {
    killTimer = setTimeout(escalateNow, killAfterMs);
  };
  if (signal.aborted) arm();
  else signal.addEventListener("abort", arm, { once: true });
  try {
    const outcome = await Promise.race([child.status, escalate]);
    if (outcome !== "kill") return outcome;
    try {
      child.kill("SIGKILL");
    } catch {
      // The child exited between the race and the kill.
    }
    return await child.status;
  } finally {
    // A timeout that fires after the child exited (while a grandchild still
    // holds the pipes) must not arm a kill timer that nothing clears.
    signal.removeEventListener("abort", arm);
    clearTimeout(killTimer);
  }
}

/** Reads a stream to EOF, or until `stop` resolves, into one array. */
async function collect(
  stream: ReadableStream<Uint8Array>,
  stop: Promise<void>,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  const stopped = stop.then(() => "stop" as const);
  try {
    while (true) {
      const next = await Promise.race([reader.read(), stopped]);
      if (next === "stop") {
        await reader.cancel();
        break;
      }
      if (next.done) break;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export interface MustSucceedOptions extends RunOptions {
  /** Names the step in the failure message; defaults to the command name. */
  label?: string;
}

/** Runs a command and returns its stdout, failing with its stderr otherwise. */
export async function mustSucceed(
  command: readonly string[],
  options: MustSucceedOptions = {},
): Promise<Uint8Array> {
  const { label, ...runOptions } = options;
  return expectSuccess(
    await run(command, runOptions),
    label ?? command[0].slice(command[0].lastIndexOf("/") + 1),
  );
}

/** Returns stdout of a completed command, failing with its stderr otherwise. */
export function expectSuccess(
  result: Deno.CommandOutput,
  label: string,
): Uint8Array {
  if (!result.success) {
    throw new Error(
      `${label} ${describeExit(result)}: ${trimmedStderr(result)}`,
    );
  }
  return result.stdout;
}

/** "exited 1", "was killed by SIGTERM" or "timed out ...", for messages. */
export function describeExit(
  result: Deno.CommandOutput & { timedOut?: boolean },
): string {
  const how = result.signal
    ? `was killed by ${result.signal}`
    : `exited ${result.code}`;
  return result.timedOut ? `timed out and ${how}` : how;
}

const decoder = new TextDecoder();

/** Decodes bytes as UTF-8 with replacement characters. */
export function decodeText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function trimmedStderr(result: Deno.CommandOutput): string {
  const text = decodeText(result.stderr).trimEnd();
  return text.length > 4000 ? `${text.slice(0, 4000)}\n... (truncated)` : text;
}
