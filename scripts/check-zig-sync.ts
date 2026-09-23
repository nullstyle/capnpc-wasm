// Verify the prepared Zig sources and the mirrored conformance fixtures
// against the capnp-zig revision this repository records: the ref/capnp-zig
// gitlink at HEAD. generators/zig/sync.json only maps native fixture paths to
// their mirrors; every expectation comes from the reference commit itself.
//
//   deno run --allow-read --allow-run=git scripts/check-zig-sync.ts
//   deno run --allow-read --allow-write=tests --allow-run=git \
//     scripts/check-zig-sync.ts --update-fixtures
const manifestPath = "generators/zig/sync.json";
const reference = "ref/capnp-zig";
const preparedSources = "build/src/capnp-zig/src";
const historicalSources = "build/src/capnp-zig-historical/src";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
type Fixture = { native: string; path: string };
type Manifest = { version: 2; fixtures: Fixture[] };
type TreeEntry = { mode: string; kind: string; object: string };

const updateFixtures = Deno.args.length === 1 &&
  Deno.args[0] === "--update-fixtures";
if (!updateFixtures && Deno.args.length !== 0) {
  throw new Error("Usage: check-zig-sync.ts [--update-fixtures]");
}

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
      if (prefix === "" && [".source-key", ".source-digest"].includes(path)) {
        continue;
      }
      found[path] = await sha256(
        await Deno.readFile(`${directory}/${entry.name}`),
      );
    } else throw new Error(`Unexpected source entry: ${path}`);
  }
  return found;
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

// Every blob of a committed tree, keyed by path, from one ls-tree call.
async function committedTree(
  cwd: string,
  revision: string,
): Promise<Record<string, TreeEntry>> {
  const entries = decoder.decode(
    await gitBytes(cwd, "ls-tree", "-r", "-z", revision),
  ).split("\0").filter(Boolean);
  const found: Record<string, TreeEntry> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("\t");
    const [mode, kind, object] = entry.slice(0, separator).split(" ");
    found[entry.slice(separator + 1)] = { mode, kind, object };
  }
  return found;
}

// Blob contents in one `git cat-file --batch` process, keyed by object id.
async function blobs(
  cwd: string,
  objects: string[],
): Promise<Map<string, Uint8Array>> {
  const unique = [...new Set(objects)];
  const child = new Deno.Command("git", {
    args: ["cat-file", "--batch"],
    cwd,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(encoder.encode(unique.map((id) => `${id}\n`).join("")));
  await writer.close();
  const result = await child.output();
  if (!result.success) throw new Error(decoder.decode(result.stderr));
  const data = result.stdout;
  const found = new Map<string, Uint8Array>();
  let offset = 0;
  for (const object of unique) {
    const newline = data.indexOf(10, offset);
    if (newline < 0) throw new Error(`Truncated cat-file output at ${object}`);
    const [id, kind, sizeText] = decoder.decode(data.subarray(offset, newline))
      .split(" ");
    if (id !== object || kind !== "blob") {
      throw new Error(`Reference object ${object} is not a blob (${kind})`);
    }
    const start = newline + 1;
    const size = Number(sizeText);
    found.set(object, data.subarray(start, start + size));
    offset = start + size + 1;
  }
  return found;
}

function sourceEntries(
  tree: Record<string, TreeEntry>,
  prefix: string,
): Record<string, TreeEntry> {
  const found: Record<string, TreeEntry> = {};
  for (const [path, entry] of Object.entries(tree)) {
    if (!path.startsWith(prefix)) continue;
    if (entry.kind !== "blob" || !["100644", "100755"].includes(entry.mode)) {
      throw new Error(`Unexpected committed source entry: ${path}`);
    }
    found[path.slice(prefix.length)] = entry;
  }
  return found;
}

// Compare a prepared export with the committed sources it claims to mirror.
async function compareSources(
  label: string,
  directory: string,
  cwd: string,
  revision: string,
) {
  const expected = sourceEntries(await committedTree(cwd, revision), "src/");
  const contents = await blobs(
    cwd,
    Object.values(expected).map((entry) => entry.object),
  );
  const actual = await inventory(directory);
  const problems: string[] = [];
  for (const path of Object.keys(expected)) {
    const hash = await sha256(contents.get(expected[path].object)!);
    if (actual[path] === undefined) problems.push(`missing ${path}`);
    else if (actual[path] !== hash) problems.push(`changed ${path}`);
  }
  for (const path of Object.keys(actual)) {
    if (expected[path] === undefined) problems.push(`extra ${path}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `${label} at ${directory} differs from ${cwd} ${revision}:\n  ${
        problems.sort().join("\n  ")
      }\nRun mise run build:zig to export the sources again.`,
    );
  }
  return Object.keys(expected).length;
}

const manifest: Manifest = JSON.parse(await Deno.readTextFile(manifestPath));
if (
  manifest.version !== 2 || !Array.isArray(manifest.fixtures) ||
  manifest.fixtures.some((fixture) =>
    typeof fixture.native !== "string" || typeof fixture.path !== "string" ||
    fixture.native.startsWith("/") || fixture.native.includes("..") ||
    !fixture.path.startsWith("tests/")
  )
) {
  throw new Error(`Invalid fixture manifest ${manifestPath}`);
}

const gitlink = await git(".", "rev-parse", `HEAD:${reference}`);
const sourceCount = await compareSources(
  "Prepared Zig source",
  preparedSources,
  reference,
  gitlink,
);

// Mirrored fixtures must be byte-identical to the native files at the gitlink.
const tree = await committedTree(reference, gitlink);
const missingNative = manifest.fixtures.filter((fixture) =>
  tree[fixture.native]?.kind !== "blob"
);
if (missingNative.length > 0) {
  throw new Error(
    `Fixture sources missing from ${reference} ${gitlink}: ${
      missingNative.map((fixture) => fixture.native).join(", ")
    }`,
  );
}
const nativeContents = await blobs(
  reference,
  manifest.fixtures.map((fixture) => tree[fixture.native].object),
);
const drifted: string[] = [];
let updated = 0;
for (const fixture of manifest.fixtures) {
  const native = nativeContents.get(tree[fixture.native].object)!;
  let mirrored: Uint8Array | undefined;
  try {
    mirrored = await Deno.readFile(fixture.path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const same = mirrored !== undefined &&
    await sha256(mirrored) === await sha256(native);
  if (same) continue;
  if (updateFixtures) {
    await Deno.writeFile(fixture.path, native);
    updated += 1;
  } else {
    drifted.push(
      `${fixture.path} (${mirrored === undefined ? "missing" : "differs"})`,
    );
  }
}
if (drifted.length > 0) {
  throw new Error(
    `Mirrored fixtures differ from ${reference} ${gitlink}:\n  ${
      drifted.join("\n  ")
    }\nRun scripts/check-zig-sync.ts --update-fixtures to copy them from the reference.`,
  );
}

const historical =
  (await Deno.readTextFile("generators/zig/historical-reference"))
    .trim();
if (!/^[a-f0-9]{40}$/.test(historical)) {
  throw new Error("Invalid historical Zig revision");
}
await compareSources(
  "Historical Zig audit source",
  historicalSources,
  reference,
  historical,
);

console.log(
  `Zig sync: ${sourceCount} sources, ${manifest.fixtures.length} fixtures match ${reference} ${gitlink}${
    updated > 0 ? ` (${updated} fixtures updated)` : ""
  }`,
);
