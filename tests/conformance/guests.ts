// The corpus guests: tiny WASI commands under tests/fixtures/conformance/guests
// that trap, recurse, flood a stream, publish hostile names, or loop. Every
// runner reads their bytes from guests.json (hex by name), so the SDK tests,
// which cannot spawn wasm-tools, and the Go test share one assembled copy.
// `mise run test:conformance` assembles every .wat with the pinned wasm-tools
// (`parse`, then `strip --all`) and fails when guests.json differs.
// Regenerate after editing a source:
//
//   mise exec -- deno run --allow-read --allow-write=tests/fixtures/conformance,build --allow-run=wasm-tools tests/conformance/guests.ts --write

export const guestsPath = "tests/fixtures/conformance/guests.json";
const sourceDirectory = "tests/fixtures/conformance/guests/";

export function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** The assembled guests by name, read from guests.json. */
export async function loadGuests(
  root: string | URL,
): Promise<Record<string, Uint8Array>> {
  const encoded: Record<string, string> = JSON.parse(
    await Deno.readTextFile(new URL(guestsPath, root)),
  );
  return Object.fromEntries(
    Object.entries(encoded).map(([name, hex]) => [name, fromHex(hex)]),
  );
}

async function wasmTools(args: string[]): Promise<void> {
  const result = await new Deno.Command("wasm-tools", {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(60_000),
  }).output();
  if (!result.success) {
    throw new Error(
      `wasm-tools ${args.join(" ")} failed: ${
        new TextDecoder().decode(result.stderr)
      }`,
    );
  }
}

/**
 * Assemble every guest source with the pinned wasm-tools (needs
 * --allow-run=wasm-tools and --allow-write=build); intermediates go under
 * build/test.
 */
export async function assembleGuests(
  root: string | URL,
): Promise<Record<string, Uint8Array>> {
  const directory = new URL(sourceDirectory, root);
  const names: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isFile && entry.name.endsWith(".wat")) {
      names.push(entry.name.slice(0, -".wat".length));
    }
  }
  const buildTest = new URL("build/test/", root);
  await Deno.mkdir(buildTest, { recursive: true });
  const work = await Deno.makeTempDir({
    dir: buildTest.pathname,
    prefix: "conformance-guests-",
  });
  const guests: Record<string, Uint8Array> = {};
  try {
    for (const name of names.sort()) {
      const named = `${work}/${name}.named.wasm`;
      const stripped = `${work}/${name}.wasm`;
      await wasmTools([
        "parse",
        new URL(`${name}.wat`, directory).pathname,
        "-o",
        named,
      ]);
      await wasmTools(["strip", "--all", named, "-o", stripped]);
      guests[name] = await Deno.readFile(stripped);
    }
  } finally {
    await Deno.remove(work, { recursive: true });
  }
  return guests;
}

function encode(guests: Record<string, Uint8Array>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(guests).sort().map((name) => [name, toHex(guests[name])]),
    ),
    null,
    2,
  ) + "\n";
}

/** Assemble the sources and compare them with guests.json; the names that differ. */
export async function driftedGuests(root: string | URL): Promise<string[]> {
  const assembled = await assembleGuests(root);
  const recorded = await loadGuests(root);
  const names = new Set([...Object.keys(assembled), ...Object.keys(recorded)]);
  return [...names].sort().filter((name) =>
    toHex(assembled[name] ?? new Uint8Array()) !==
      toHex(recorded[name] ?? new Uint8Array())
  );
}

if (import.meta.main) {
  const root = new URL("../../", import.meta.url);
  if (Deno.args.includes("--write")) {
    const guests = await assembleGuests(root);
    await Deno.writeTextFile(new URL(guestsPath, root), encode(guests));
    console.log(`wrote ${guestsPath} (${Object.keys(guests).length} guests)`);
  } else {
    const drifted = await driftedGuests(root);
    if (drifted.length > 0) {
      console.error(
        `${guestsPath} is stale for ${drifted.join(", ")}; run with --write`,
      );
      Deno.exit(1);
    }
    console.log(`${guestsPath} matches its sources`);
  }
}
