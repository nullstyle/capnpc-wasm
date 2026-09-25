import { fileURLToPath } from "node:url";
import { type Engine, selectedEngines } from "./engines.ts";
import { envMilliseconds } from "./deadline.ts";
import {
  describeObservation,
  type Observation,
} from "../conformance/outcome.ts";

type Receipt = {
  engine: string;
  scenarios: {
    name: string;
    canonicalPath: string;
    requests: { host: string; path: string }[];
  }[];
  conformance?: Record<string, { observed: number; skipped: number }>;
  conformanceRows?: {
    name: string;
    surface: string;
    accepted?: string[];
    observation?: Observation;
  }[];
  termination?: { verdict: string }[];
};

async function verifyRequests(receiptPath: string, engine: string) {
  const receipt: Receipt = JSON.parse(await Deno.readTextFile(receiptPath));
  if (receipt.engine !== engine || receipt.scenarios.length === 0) {
    throw new Error(`Missing ${engine} canonical request evidence`);
  }
  for (const scenario of receipt.scenarios) {
    if (
      JSON.stringify(
        scenario.requests.map((request) => request.host).sort(),
      ) !==
        JSON.stringify(["direct", "worker"])
    ) {
      throw new Error(
        `${engine} ${scenario.name}: missing direct/worker request`,
      );
    }
    const expected = await Deno.readFile(scenario.canonicalPath);
    for (const request of scenario.requests) {
      const bytes = await Deno.readFile(request.path);
      const command = new Deno.Command(
        `${Deno.cwd()}/build/native/bin/normalize-request`,
        {
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
          signal: AbortSignal.timeout(60_000),
        },
      ).spawn();
      const result = command.output();
      const writer = command.stdin.getWriter();
      try {
        await writer.write(bytes);
        await writer.close();
      } catch (error) {
        if (!(error instanceof Deno.errors.BrokenPipe)) throw error;
      } finally {
        writer.releaseLock();
      }
      const output = await result;
      if (!output.success) {
        throw new Error(new TextDecoder().decode(output.stderr));
      }
      await Deno.writeFile(`${request.path}.canonical`, output.stdout);
      if (
        expected.length !== output.stdout.length ||
        expected.some((byte, index) => byte !== output.stdout[index])
      ) {
        throw new Error(
          `${engine} ${request.host} ${scenario.name}: complete canonical request differs from native`,
        );
      }
    }
  }
  return receipt;
}

// Each driver revokes its own network and process permissions after loading
// assets. A separate process per engine preserves that offline boundary. The
// parent only canonicalizes saved requests after that isolated driver exits.
//
// The drivers run at once (PERF-06), each with an overall deadline (TST-07):
// a driver that overruns it receives SIGTERM, reports the step it was on, and
// is killed if it has not exited 30 seconds later. CAPNP_BROWSER_JOBS=1 runs
// the engines one after another; CAPNP_BROWSER_ENGINE_TIMEOUT_MS sets the
// deadline (20 minutes by default).
const engineTimeoutMs = envMilliseconds(
  "CAPNP_BROWSER_ENGINE_TIMEOUT_MS",
  20 * 60_000,
);
const jobs = Number(Deno.env.get("CAPNP_BROWSER_JOBS") || 3);
if (!Number.isInteger(jobs) || jobs < 1) {
  throw new TypeError("CAPNP_BROWSER_JOBS must be a positive integer");
}
const killGraceMs = 30_000;

/** Copy a driver's stream to ours line by line, prefixed with its engine. */
async function relay(
  stream: ReadableStream<Uint8Array>,
  prefix: string,
  write: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      write(`${prefix}${pending.slice(0, newline)}`);
      pending = pending.slice(newline + 1);
    }
  }
  pending += decoder.decode();
  if (pending) write(`${prefix}${pending}`);
}

function lastStep(receiptPath: string): string {
  try {
    return Deno.readTextFileSync(`${receiptPath}.step`).trim() || "unknown";
  } catch {
    return "unknown (no step recorded)";
  }
}

interface Outcome {
  engine: Engine;
  passed: boolean;
  seconds: number;
  summary: string[];
}

async function runEngine(engine: Engine, receipts: string): Promise<Outcome> {
  const started = performance.now();
  const receiptPath = `${receipts}/${engine}.json`;
  const prefix = `[${engine}] `;
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--config",
      fileURLToPath(new URL("./deno.json", import.meta.url)),
      "--frozen",
      "--no-prompt",
      "--allow-read",
      "--allow-write=build",
      "--allow-run",
      "--allow-env",
      "--allow-sys",
      "--allow-net=127.0.0.1",
      fileURLToPath(new URL("./test.ts", import.meta.url)),
      engine,
      receiptPath,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const relayed = Promise.all([
    relay(child.stdout, prefix, (line) => console.log(line)),
    relay(child.stderr, prefix, (line) => console.error(line)),
  ]);
  let overran: string | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = setTimeout(() => {
    overran = lastStep(receiptPath);
    console.error(
      `${prefix}FAIL ${engine}: the driver overran its ${
        engineTimeoutMs / 1000
      }-second deadline during: ${overran}; stopping it`,
    );
    try {
      child.kill("SIGTERM");
    } catch {
      // It exited in the meantime.
    }
    killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // It exited in the meantime.
      }
    }, killGraceMs);
  }, engineTimeoutMs);
  const status = await child.status;
  clearTimeout(deadline);
  clearTimeout(killTimer);
  // A browser process that inherited the pipes must not hold the run open.
  await Promise.race([
    relayed,
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  const seconds = Math.round((performance.now() - started) / 1000);
  if (overran !== undefined) {
    return {
      engine,
      passed: false,
      seconds,
      summary: [`stopped after overrunning its deadline during: ${overran}`],
    };
  }
  if (!status.success) {
    return {
      engine,
      passed: false,
      seconds,
      summary: [
        `browser suite failed (exit ${status.code}) during: ${
          lastStep(receiptPath)
        }`,
      ],
    };
  }
  try {
    const receipt = await verifyRequests(receiptPath, engine);
    return {
      engine,
      passed: true,
      seconds,
      summary: [
        `offline SDK parity and canonical requests for ${receipt.scenarios.length} scenarios`,
        ...Object.entries(receipt.conformance ?? {}).map(([surface, count]) =>
          `${surface}: ${count.observed} conformance rows as expected, ${count.skipped} not expressible`
        ),
        ...(receipt.conformanceRows ?? []).filter((row) => row.accepted).map(
          (row) =>
            `observed ${row.surface} ${row.name}: ${
              row.observation
                ? describeObservation(row.observation)
                : "no observation"
            } (accepts ${row.accepted!.join(" or ")})`,
        ),
        ...(receipt.termination ?? []).map((result) => result.verdict),
      ],
    };
  } catch (error) {
    return {
      engine,
      passed: false,
      seconds,
      summary: [`canonical request verification failed: ${error}`],
    };
  }
}

await Deno.mkdir("build/test", { recursive: true });
const receipts = await Deno.makeTempDir({
  dir: "build/test",
  prefix: "browser-verification-",
});
const queue = [...selectedEngines(Deno.args)];
const outcomes: Outcome[] = [];
await Promise.all(
  Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let engine = queue.shift(); engine; engine = queue.shift()) {
      outcomes.push(await runEngine(engine, receipts));
    }
  }),
);
console.log(`Browser verification (receipts in ${receipts}):`);
for (const outcome of outcomes) {
  console.log(
    `${
      outcome.passed ? "PASS" : "FAIL"
    } ${outcome.engine} (${outcome.seconds} s)`,
  );
  for (const line of outcome.summary) console.log(`  ${line}`);
}
if (outcomes.some((outcome) => !outcome.passed)) Deno.exit(1);
