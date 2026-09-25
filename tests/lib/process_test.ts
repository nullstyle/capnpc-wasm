// Self-checks for the subprocess runner. Needs --allow-run=sh, --allow-env
// (so children get the minimal environment) and --allow-read=tests/lib.
import { assert, assertBytesEqual } from "./assert.ts";
import { root } from "./paths.ts";
import { describeExit, run, type RunResult } from "./process.ts";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * A child that ignores SIGTERM and spins until SIGKILL, or until this test
 * process is gone: a runner killed before the escalation reaches the child
 * must not leave it spinning (ledger row 119). `kill -0` is a shell builtin,
 * so the loop starts no process, and the child never reads stdin. It prints
 * `armed` once SIGTERM is ignored: on a loaded host a SIGTERM can reach sh
 * before the trap and end it (ledger row 130), so the tests check the marker
 * before the signal.
 */
const ignoresTerm = [
  "sh",
  "-c",
  'trap "" TERM; echo armed; while kill -0 "$1" 2>/dev/null; do :; done',
  "sh",
  String(Deno.pid),
];

/**
 * The timeout leaves a loaded host two seconds to start sh and install the
 * trap before SIGTERM; SIGKILL follows 200 ms after it.
 */
const escalation = { timeoutMs: 2_000, killAfterMs: 200 };

/** The marker shows the child ignored SIGTERM, so only SIGKILL can end it. */
function assertArmed(result: RunResult) {
  assert(
    text(result.stdout) === "armed\n",
    `the child was not armed when the timeout fired (stdout ${
      JSON.stringify(text(result.stdout))
    }, ${
      describeExit(result)
    }): SIGTERM reached sh before trap "" TERM, so this run cannot show the escalation`,
  );
}

Deno.test("run captures stdout, stderr and the exit status", async () => {
  const result = await run(["sh", "-c", "printf out; printf err >&2; exit 3"]);
  assert(
    result.code === 3 && result.signal === null && !result.timedOut &&
      text(result.stdout) === "out" && text(result.stderr) === "err",
    `unexpected result ${describeExit(result)}: ${
      JSON.stringify([text(result.stdout), text(result.stderr)])
    }`,
  );
  assert(describeExit(result) === "exited 3", describeExit(result));
});

Deno.test("run feeds stdin from bytes or from a regular file", async () => {
  const bytes = new Uint8Array([0, 255, 10, 13, 65]);
  const piped = await run(["sh", "-c", "cat"], { stdin: bytes });
  assertBytesEqual(piped.stdout, bytes, "piped stdin");
  const file = `${root}/tests/lib/README.md`;
  const fromFile = await run(["sh", "-c", "cat"], { stdinFile: file });
  assertBytesEqual(fromFile.stdout, await Deno.readFile(file), "file stdin");
});

Deno.test("run stops waiting for pipes a grandchild holds after the timeout", async () => {
  const started = performance.now();
  // The backgrounded sleep inherits stdout and stderr and outlives sh.
  const result = await run(
    ["sh", "-c", "sleep 5 & printf partial; sleep 5"],
    { timeoutMs: 300 },
  );
  const elapsed = performance.now() - started;
  assert(
    result.timedOut && result.signal === "SIGTERM" &&
      text(result.stdout) === "partial",
    `unexpected result ${describeExit(result)}: ${
      JSON.stringify(text(result.stdout))
    }`,
  );
  assert(elapsed < 3_000, `run returned only after ${Math.round(elapsed)} ms`);
  assert(
    describeExit(result) === "timed out and was killed by SIGTERM",
    describeExit(result),
  );
});

Deno.test("run escalates to SIGKILL when the child ignores SIGTERM", async () => {
  const result = await run(ignoresTerm, escalation);
  assertArmed(result);
  assert(
    result.timedOut && result.signal === "SIGKILL",
    `unexpected result ${describeExit(result)}`,
  );
});

/** Fails instead of hanging when a regression leaves `pending` unsettled. */
async function settlesWithin<T>(pending: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`run did not return within ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

Deno.test("run escalates to SIGKILL while a stalled stdin write is pending", async () => {
  const started = performance.now();
  // A megabyte fills the pipe: the write blocks until the child is gone, and
  // the child ignores SIGTERM and never reads.
  const result = await settlesWithin(
    run(ignoresTerm, { stdin: new Uint8Array(1 << 20), ...escalation }),
    10_000,
  );
  const elapsed = performance.now() - started;
  assertArmed(result);
  assert(
    result.timedOut && result.signal === "SIGKILL",
    `unexpected result ${describeExit(result)}`,
  );
  // The pending write must not hold run() past the kill.
  const bound = escalation.timeoutMs + escalation.killAfterMs + 2_500;
  assert(
    elapsed < bound,
    `run returned only after ${Math.round(elapsed)} ms (bound ${bound} ms)`,
  );
});

Deno.test("run leaves no kill timer behind when the timeout fires after the child exited", async () => {
  // A separate Deno process runs the scenario and must exit on its own soon
  // after run() returns. sh exits at once, and the backgrounded sleep keeps
  // the pipes open until the timeout stops the reads; a kill timer that the
  // late timeout armed would hold that process for killAfterMs (20 s). Deno's
  // op sanitizer does not report such a timer, so the lifetime is measured.
  const scenario = `
    import { run } from "./tests/lib/process.ts";
    const result = await run(["sh", "-c", "sleep 2 & printf partial"], {
      timeoutMs: 300,
      killAfterMs: 20000,
    });
    console.log(JSON.stringify({ timedOut: result.timedOut, code: result.code }));
  `;
  const started = performance.now();
  const result = await run(
    ["sh", "-c", 'exec deno eval --no-config "$0"', scenario],
    { timeoutMs: 15_000 },
  );
  const elapsed = performance.now() - started;
  assert(
    result.success && !result.timedOut,
    `the scenario process ${describeExit(result)}: ${text(result.stderr)}`,
  );
  assert(
    text(result.stdout).includes('"timedOut":true,"code":0'),
    text(result.stdout),
  );
  assert(
    elapsed < 10_000,
    `the scenario process lived ${
      Math.round(elapsed)
    } ms: a kill timer outlived run()`,
  );
});
