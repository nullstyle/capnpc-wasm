// The worker termination canary (GAP2-08), an upstream tracker and not a gate:
// runs worker-termination-probe.ts in every guest mode under each Deno runtime
// named on the command line (`label=path/to/deno`), bounds every run from
// outside, and compares the result with the recorded behavior in
// docs/deno-worker-termination.md: the last release that stops a spinning guest
// (lastStoppingRelease) stops it after its two-second grace, and every later
// release tested keeps it running. Either departure, an upstream fix or a
// runtime that stops JavaScript but not Wasm, fails the canary. The SDK does not
// rely on Worker.terminate(); the nightly workflow runs the canary on the pinned
// and the newest Deno without gating.
//
//   deno run --allow-read --allow-write=build/test --allow-run \
//     tests/hosts/deno/worker-termination-canary.ts pinned=<deno> latest=<deno>

/**
 * The last Deno release whose Worker.terminate() stops a running guest (after
 * a two-second grace), as docs/deno-worker-termination.md records.
 */
const lastStoppingRelease = "2.6.8";

const modes = ["js", "wasm", "wasm-catch-all"] as const;
/** The probe reports at four seconds; affected releases never exit on their own. */
const deadlineMs = 8_000;
const directory = new URL(".", import.meta.url).pathname;
const receiptPath = "build/test/termination-canary.json";

interface Row {
  runtime: string;
  version: string;
  mode: string;
  expected: "stops" | "continues";
  observed: "stops" | "continues" | "no report";
  exitedBeforeDeadline: boolean;
  atTermination?: number;
  afterThreeSeconds?: number;
  afterFourSeconds?: number;
  caught?: number;
  detail?: string;
}

async function version(path: string): Promise<string> {
  const output = await new Deno.Command(path, {
    args: ["--version"],
    stdout: "piped",
    stderr: "null",
  }).output();
  const match = /^deno (\S+)/.exec(new TextDecoder().decode(output.stdout));
  if (!output.success || !match) {
    throw new Error(`${path} --version did not report a Deno version`);
  }
  return match[1];
}

async function probe(
  path: string,
  label: string,
  mode: string,
): Promise<Omit<Row, "runtime" | "version" | "mode" | "expected">> {
  await Deno.mkdir(`build/test/termination-canary/${label}`, {
    recursive: true,
  });
  const child = new Deno.Command(path, {
    args: [
      "run",
      "--no-config",
      "--no-prompt",
      `--allow-read=${directory}`,
      `${directory}worker-termination-probe.ts`,
      mode,
    ],
    // A cache per runtime: releases do not share a cache format.
    env: {
      DENO_DIR: `${Deno.cwd()}/build/test/termination-canary/${label}`,
      NO_COLOR: "1",
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // It exited between the deadline and the kill.
    }
  }, deadlineMs);
  const output = await child.output();
  clearTimeout(timer);
  const text = new TextDecoder().decode(output.stdout).trim();
  const line = text.split("\n").at(-1) ?? "";
  try {
    const report = JSON.parse(line);
    return {
      observed: report.continuedAfterThreeSeconds ? "continues" : "stops",
      exitedBeforeDeadline: !killed,
      atTermination: report.atTermination,
      afterThreeSeconds: report.afterThreeSeconds,
      afterFourSeconds: report.afterFourSeconds,
      caught: report.caught,
    };
  } catch {
    return {
      observed: "no report",
      exitedBeforeDeadline: !killed,
      detail: (text + new TextDecoder().decode(output.stderr)).slice(0, 300),
    };
  }
}

if (Deno.args.length === 0) {
  throw new TypeError("name at least one runtime as label=path/to/deno");
}
const rows: Row[] = [];
for (const argument of Deno.args) {
  const split = argument.indexOf("=");
  if (split <= 0) throw new TypeError(`expected label=path, got ${argument}`);
  const label = argument.slice(0, split);
  const path = argument.slice(split + 1);
  const runtimeVersion = await version(path);
  for (const mode of modes) {
    rows.push({
      runtime: label,
      version: runtimeVersion,
      mode,
      expected: runtimeVersion === lastStoppingRelease ? "stops" : "continues",
      ...await probe(path, label, mode),
    });
  }
}
const changed = rows.filter((row) => row.observed !== row.expected);
console.log(
  "| Runtime | Deno | Guest | Counter stable between 3 s and 4 s | Exited before 8 s | Expected |",
);
console.log("| --- | --- | --- | --- | --- | --- |");
for (const row of rows) {
  console.log(
    `| ${row.runtime} | ${row.version} | ${row.mode} | ${
      row.observed === "stops"
        ? "yes"
        : row.observed === "continues"
        ? "no"
        : "no report"
    } | ${row.exitedBeforeDeadline ? "yes" : "no"} | ${
      row.observed === row.expected
        ? "as recorded"
        : `CHANGED (${row.expected})`
    } |`,
  );
}
await Deno.mkdir("build/test", { recursive: true });
await Deno.writeTextFile(
  receiptPath,
  JSON.stringify(
    { lastStoppingRelease, deadlineMs, rows, changed: changed.length },
    null,
    2,
  ) + "\n",
);
if (changed.length > 0) {
  console.error(
    `${changed.length} result(s) departed from the recorded behavior: ${
      changed.map((row) => `${row.runtime} ${row.version} ${row.mode}`).join(
        ", ",
      )
    }; record the change in docs/deno-worker-termination.md`,
  );
  Deno.exit(1);
}
console.log(
  `Every result matches the recorded behavior; receipt ${receiptPath}`,
);
