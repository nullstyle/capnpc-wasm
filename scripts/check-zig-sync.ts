// Verify the prepared runtime and mirrored fixtures without a native checkout.
// Maintainers record a new manifest explicitly after committing native sources.
const manifestPath = "generators/zig/sync.json";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
type Fixture = { native: string; path: string; sha256: string };
type Manifest = {
  version: 1;
  nativeCommit: string;
  referenceCommit: string;
  sourceDigest: string;
  sources: Record<string, string>;
  fixtures: Fixture[];
};

async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
  )
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function inventory(
  directory: string,
  prefix = "",
): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for await (const entry of Deno.readDir(directory)) {
    const path = prefix + entry.name;
    if (entry.isDirectory) {
      Object.assign(
        found,
        await inventory(`${directory}/${entry.name}`, `${path}/`),
      );
    } else if (entry.isFile) {
      found[path] = await sha256(
        await Deno.readFile(`${directory}/${entry.name}`),
      );
    } else throw new Error(`Unexpected source entry: ${path}`);
  }
  return Object.fromEntries(
    Object.entries(found).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  );
}

async function gitBytes(cwd: string, ...args: string[]) {
  const result = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) throw new Error(decoder.decode(result.stderr));
  return result.stdout;
}

async function git(cwd: string, ...args: string[]) {
  return decoder.decode(await gitBytes(cwd, ...args)).trim();
}

async function committedInventory(
  cwd: string,
): Promise<Record<string, string>> {
  const entries = decoder.decode(
    await gitBytes(cwd, "ls-tree", "-r", "-z", "HEAD:src"),
  ).split("\0").filter(Boolean);
  const found: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("\t");
    const [mode, kind, object] = entry.slice(0, separator).split(" ");
    const path = entry.slice(separator + 1);
    if (kind !== "blob" || !["100644", "100755"].includes(mode)) {
      throw new Error(`Unexpected committed source entry: ${path}`);
    }
    found[path] = await sha256(await gitBytes(cwd, "cat-file", "blob", object));
  }
  return Object.fromEntries(
    Object.entries(found).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  );
}

async function digest(sources: Record<string, string>) {
  return await sha256(
    encoder.encode(
      Object.entries(sources).map(([path, hash]) => `${hash}  ${path}\n`).join(
        "",
      ),
    ),
  );
}

const manifest: Manifest = JSON.parse(await Deno.readTextFile(manifestPath));
const recording = Deno.args[0] === "--record-native" && Deno.args.length === 2;
if (recording) {
  const native = Deno.args[1];
  const paths = ["src", ...manifest.fixtures.map((fixture) => fixture.native)];
  if (await git(native, "status", "--porcelain", "--", ...paths)) {
    throw new Error(
      "Commit native sources and mirrored fixtures before recording synchronization",
    );
  }
  manifest.nativeCommit = await git(native, "rev-parse", "HEAD");
  manifest.referenceCommit = await git("ref/capnp-zig", "rev-parse", "HEAD");
  manifest.sources = await committedInventory(native);
  manifest.sourceDigest = await digest(manifest.sources);
  if (
    await digest(await inventory(`${native}/src`)) !== manifest.sourceDigest
  ) {
    throw new Error("Native source files differ from the committed tree");
  }
  for (const fixture of manifest.fixtures) {
    const sourceHash = await sha256(
      await gitBytes(native, "show", `HEAD:${fixture.native}`),
    );
    if (
      await sha256(await Deno.readFile(`${native}/${fixture.native}`)) !==
        sourceHash
    ) throw new Error(`Native fixture differs from commit: ${fixture.native}`);
    const mirroredHash = await sha256(await Deno.readFile(fixture.path));
    if (sourceHash !== mirroredHash) {
      throw new Error(`Fixture differs from native: ${fixture.path}`);
    }
    fixture.sha256 = sourceHash;
  }
} else if (Deno.args.length !== 0) {
  throw new Error("Usage: check-zig-sync.ts [--record-native CHECKOUT]");
}

if (manifest.version !== 1 || !/^[a-f0-9]{40}$/.test(manifest.nativeCommit)) {
  throw new Error("Invalid native source manifest");
}
if (
  await git("ref/capnp-zig", "rev-parse", "HEAD") !== manifest.referenceCommit
) throw new Error("Reference revision differs from sync metadata");
const actual = await inventory("build/src/capnp-zig/src");
const differences = new Set([
  ...Object.keys(actual),
  ...Object.keys(manifest.sources),
]);
for (const path of differences) {
  if (actual[path] !== manifest.sources[path]) {
    throw new Error(
      `Prepared Zig source differs from native manifest: ${path}`,
    );
  }
}
if (await digest(actual) !== manifest.sourceDigest) {
  throw new Error("Zig source digest mismatch");
}
for (const fixture of manifest.fixtures) {
  if (await sha256(await Deno.readFile(fixture.path)) !== fixture.sha256) {
    throw new Error(`Mirrored fixture changed: ${fixture.path}`);
  }
}
if (recording) {
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify(manifest, null, 2) + "\n",
  );
}
console.log(
  `Zig sync: ${
    Object.keys(actual).length
  } sources, ${manifest.fixtures.length} fixtures match native ${manifest.nativeCommit}`,
);
