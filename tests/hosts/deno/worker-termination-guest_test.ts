// The probe's embedded Wasm guest must equal its source assembled with the
// pinned wasm-tools (`parse`, then `strip --all`). Runs in test:conformance.
import { spinGuest, spinGuestSource } from "./worker-termination-guest.ts";

async function wasmTools(args: string[]): Promise<void> {
  const output = await new Deno.Command("wasm-tools", {
    args,
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `wasm-tools ${args.join(" ")}: ${
        new TextDecoder().decode(output.stderr)
      }`,
    );
  }
}

Deno.test("the termination probe's Wasm guest matches its source", async () => {
  await Deno.mkdir("build/test", { recursive: true });
  const work = await Deno.makeTempDir({
    dir: "build/test",
    prefix: "termination-guest-",
  });
  try {
    await Deno.writeTextFile(`${work}/spin.wat`, spinGuestSource);
    await wasmTools(["parse", `${work}/spin.wat`, "-o", `${work}/named.wasm`]);
    await wasmTools([
      "strip",
      "--all",
      `${work}/named.wasm`,
      "-o",
      `${work}/spin.wasm`,
    ]);
    const assembled = await Deno.readFile(`${work}/spin.wasm`);
    if (
      assembled.length !== spinGuest.length ||
      assembled.some((byte, index) => byte !== spinGuest[index])
    ) {
      throw new Error(
        "tests/hosts/deno/worker-termination-guest.ts: the embedded bytes no longer match spinGuestSource; reassemble them",
      );
    }
  } finally {
    await Deno.remove(work, { recursive: true });
  }
});
