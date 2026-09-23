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
    ["sh", "-c", "sleep 30 & printf partial; sleep 30"],
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
  assert(elapsed < 5_000, `run returned only after ${Math.round(elapsed)} ms`);
  assert(
    describeExit(result) === "timed out and was killed by SIGTERM",
    describeExit(result),
  );
});

Deno.test("run escalates to SIGKILL when the child ignores SIGTERM", async () => {
  const result = await run(["sh", "-c", 'trap "" TERM; sleep 30'], {
    timeoutMs: 200,
    killAfterMs: 200,
  });
  assert(
    result.timedOut && result.signal === "SIGKILL",
    `unexpected result ${describeExit(result)}`,
  );
});
