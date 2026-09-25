// Self-checks for the subprocess runner. Needs --allow-run=sh, --allow-env
// (so children get the minimal environment) and --allow-read=tests/lib.
import { assert, assertBytesEqual } from "./assert.ts";
import { root } from "./paths.ts";
import { describeExit, run } from "./process.ts";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

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
  const result = await run(["sh", "-c", 'trap "" TERM; sleep 5'], {
    timeoutMs: 200,
    killAfterMs: 200,
  });
  assert(
    result.timedOut && result.signal === "SIGKILL",
    `unexpected result ${describeExit(result)}`,
  );
});

Deno.test("run escalates to SIGKILL while a stalled stdin write is pending", async () => {
  const started = performance.now();
  // A megabyte fills the pipe: the write blocks until the child is gone, and
  // the child ignores SIGTERM and never reads.
  const result = await run(
    ["sh", "-c", 'trap "" TERM; while :; do :; done'],
    { stdin: new Uint8Array(1 << 20), timeoutMs: 200, killAfterMs: 200 },
  );
  const elapsed = performance.now() - started;
  assert(
    result.timedOut && result.signal === "SIGKILL",
    `unexpected result ${describeExit(result)}`,
  );
  assert(elapsed < 3_000, `run returned only after ${Math.round(elapsed)} ms`);
});
