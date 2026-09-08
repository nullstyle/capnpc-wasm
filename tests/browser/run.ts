import { fileURLToPath } from "node:url";
import { selectedEngines } from "./engines.ts";

// Each driver revokes its own network and process permissions after loading
// assets. A separate process per engine preserves that offline boundary.
let failed = false;
for (const engine of selectedEngines(Deno.args)) {
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
    ],
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) {
    failed = true;
    console.error(`FAIL ${engine} browser suite (exit ${status.code})`);
  }
}
if (failed) Deno.exit(1);
