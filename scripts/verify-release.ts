// Standalone package integrity verifier; copied into every release archive.
//
// Usage: verify-release.ts [--sums SHA256SUMS] [--expect-manifest-sha256 HEX]
//                          [--expect-commit SHA] [--require-clean] [ROOT]
//
// ROOT is the extracted package/ directory (default: the current directory).
// --sums checks every file that a SHA256SUMS file lists, next to that file,
// and ties the extracted manifest to the listed manifest asset. The other
// options pin the extracted manifest to a digest published through another
// channel, to the tagged commit, and to a clean producer tree. Run the copy
// from a repository checkout at the release tag rather than the one inside the
// archive when the archive itself is what you are verifying.
export interface ReleaseFile {
  path: string;
  bytes: number;
  sha256: string;
}
export interface ReleaseManifest {
  format: 1;
  name: string;
  version: string;
  source: { commit: string; dirty: boolean; sha256: string };
  references: Record<string, string>;
  files: ReleaseFile[];
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
export async function packageFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(path: string) {
    for await (const entry of Deno.readDir(`${root}/${path}`)) {
      const relative = path + entry.name;
      if (entry.isSymlink) {
        throw new Error(`package symlink is forbidden: ${relative}`);
      }
      if (entry.isDirectory) await visit(`${relative}/`);
      else if (entry.isFile) files.push(relative);
      else throw new Error(`unsupported package entry: ${relative}`);
    }
  }
  await visit("");
  return files.sort();
}
export async function verifyRelease(root: string): Promise<ReleaseManifest> {
  const manifest = JSON.parse(
    await Deno.readTextFile(`${root}/manifest.json`),
  ) as ReleaseManifest;
  if (
    manifest.format !== 1 || !Array.isArray(manifest.files) ||
    !manifest.version || !manifest.source?.sha256 ||
    typeof manifest.source.commit !== "string" ||
    typeof manifest.source.dirty !== "boolean"
  ) throw new Error("invalid release manifest");
  const expected = new Set<string>(["manifest.json"]);
  for (const file of manifest.files) {
    if (
      typeof file.path !== "string" || file.path.includes("\\") ||
      file.path.includes("\0") || file.path.split("/").some((part) =>
        !part || part === "." || part === ".."
      ) || expected.has(file.path)
    ) {
      throw new Error("invalid or duplicate manifest path");
    }
    if (
      !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error(`invalid manifest digest: ${file.path}`);
    }
    expected.add(file.path);
  }
  const actual = await packageFiles(root);
  if (
    actual.length !== expected.size ||
    actual.some((path) => !expected.has(path))
  ) throw new Error("package files do not match manifest inventory");
  for (const file of manifest.files) {
    const data = await Deno.readFile(`${root}/${file.path}`);
    if (data.length !== file.bytes || await sha256(data) !== file.sha256) {
      throw new Error(`package integrity mismatch: ${file.path}`);
    }
  }
  const metadata = JSON.parse(await Deno.readTextFile(`${root}/package.json`));
  if (
    metadata.name !== manifest.name || metadata.version !== manifest.version
  ) throw new Error("package identity does not match manifest");
  return manifest;
}

export interface SumsEntry {
  path: string;
  sha256: string;
}

/**
 * Checks every file listed in a SHA256SUMS file (`<hex>  <name>` lines, as
 * sha256sum writes them) against the file of that name next to it. Every
 * listed file must be present: the list is the set of release assets.
 */
export async function verifySums(sums: string): Promise<SumsEntry[]> {
  const directory = sums.includes("/")
    ? sums.slice(0, sums.lastIndexOf("/"))
    : ".";
  const entries: SumsEntry[] = [];
  for (const line of (await Deno.readTextFile(sums)).split("\n")) {
    if (line.trim() === "") continue;
    const match = /^([a-f0-9]{64}) [ *](\S.*)$/.exec(line);
    if (!match) throw new Error(`malformed SHA256SUMS line: ${line}`);
    const [, digest, path] = match;
    if (path.includes("/") || path === "." || path === "..") {
      throw new Error(`SHA256SUMS names a file outside its directory: ${path}`);
    }
    const data = await Deno.readFile(`${directory}/${path}`).catch(() => {
      throw new Error(`SHA256SUMS lists a missing file: ${path}`);
    });
    if (await sha256(data) !== digest) {
      throw new Error(`SHA256SUMS digest mismatch: ${path}`);
    }
    entries.push({ path, sha256: digest });
  }
  if (entries.length === 0) throw new Error("SHA256SUMS lists no files");
  return entries;
}

export interface VerifyOptions {
  root: string;
  sums?: string;
  expectManifestSha256?: string;
  expectCommit?: string;
  requireClean?: boolean;
}

export function parseArguments(args: string[]): VerifyOptions {
  const usage =
    "usage: verify-release.ts [--sums SHA256SUMS] [--expect-manifest-sha256 HEX] [--expect-commit SHA] [--require-clean] [ROOT]";
  const options: VerifyOptions = { root: "." };
  let root: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = () => {
      const next = args[++index];
      if (next === undefined) throw new Error(usage);
      return next;
    };
    if (arg === "--sums") options.sums = value();
    else if (arg === "--expect-manifest-sha256") {
      options.expectManifestSha256 = value().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(options.expectManifestSha256)) {
        throw new Error(usage);
      }
    } else if (arg === "--expect-commit") {
      options.expectCommit = value().toLowerCase();
      if (!/^[a-f0-9]{7,40}$/.test(options.expectCommit)) {
        throw new Error(usage);
      }
    } else if (arg === "--require-clean") options.requireClean = true;
    else if (arg.startsWith("-") || root !== undefined) throw new Error(usage);
    else root = arg;
  }
  return { ...options, root: root ?? "." };
}

/** Runs every requested check and returns the verified manifest. */
export async function verify(options: VerifyOptions): Promise<ReleaseManifest> {
  const manifestBytes = await Deno.readFile(`${options.root}/manifest.json`);
  const manifestDigest = await sha256(manifestBytes);
  if (options.sums !== undefined) {
    const entries = await verifySums(options.sums);
    const asset = entries.find((entry) =>
      entry.path.endsWith(".manifest.json")
    );
    if (asset && asset.sha256 !== manifestDigest) {
      throw new Error(
        `extracted manifest.json differs from the ${asset.path} listed in SHA256SUMS`,
      );
    }
  }
  if (
    options.expectManifestSha256 !== undefined &&
    options.expectManifestSha256 !== manifestDigest
  ) {
    throw new Error(
      `manifest.json digest ${manifestDigest} does not match the expected ${options.expectManifestSha256}`,
    );
  }
  const manifest = await verifyRelease(options.root);
  if (
    options.expectCommit !== undefined &&
    !manifest.source.commit.startsWith(options.expectCommit)
  ) {
    throw new Error(
      `manifest source commit ${manifest.source.commit} does not match the expected ${options.expectCommit}`,
    );
  }
  if (options.requireClean && manifest.source.dirty) {
    throw new Error(
      "manifest records a dirty producer tree (source.dirty is true)",
    );
  }
  return manifest;
}

if (import.meta.main) {
  const options = parseArguments(Deno.args);
  const manifest = await verify(options);
  console.log(
    `Verified ${manifest.name}@${manifest.version}: ${manifest.files.length} files, commit ${manifest.source.commit}${
      manifest.source.dirty ? " (dirty producer tree)" : ""
    }${options.sums !== undefined ? `, SHA256SUMS ${options.sums}` : ""}`,
  );
}
