import { fileURLToPath } from "node:url";
import { selectedEngines } from "./engines.ts";

type Receipt = {
  engine: string;
  scenarios: {
    name: string;
    canonicalPath: string;
    requests: { host: string; path: string }[];
  }[];
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
      console.log(
        `PASS ${engine} ${request.host}: ${scenario.name} complete canonical request matches native`,
      );
    }
  }
}

// Each driver revokes its own network and process permissions after loading
// assets. A separate process per engine preserves that offline boundary. The
// parent only canonicalizes saved requests after that isolated driver exits.
let failed = false;
await Deno.mkdir("build/test", { recursive: true });
const receipts = await Deno.makeTempDir({
  dir: "build/test",
  prefix: "browser-verification-",
});
for (const engine of selectedEngines(Deno.args)) {
  const receiptPath = `${receipts}/${engine}.json`;
  const status = await new Deno.Command(Deno.execPath(), {
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
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) {
    failed = true;
    console.error(`FAIL ${engine} browser suite (exit ${status.code})`);
    continue;
  }
  try {
    await verifyRequests(receiptPath, engine);
    console.log(
      `PASS ${engine}: offline SDK and canonical request verification`,
    );
  } catch (error) {
    failed = true;
    console.error(`FAIL ${engine} canonical request verification: ${error}`);
  }
}
if (failed) Deno.exit(1);
