/** Standalone package integrity verifier; copied into every release candidate. */
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
    !manifest.version || !manifest.source?.sha256
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
if (import.meta.main) {
  const root = Deno.args[0] ?? ".";
  const manifest = await verifyRelease(root);
  console.log(
    `Verified ${manifest.name}@${manifest.version}: ${manifest.files.length} files`,
  );
}
