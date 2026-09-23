// Directory helpers shared by the Deno test suites. Trees are maps from
// relative POSIX paths to file bytes; only regular files and directories are
// accepted, so a symlink or special file in a fixture or output fails loudly.

/** Relative POSIX path to file bytes, iterated in sorted path order. */
export type Tree = Map<string, Uint8Array>;

/** Either a tree or a plain object with the same shape, as the SDKs return. */
export type TreeLike = Tree | Record<string, Uint8Array>;

/** Normalizes a record or map into a sorted tree. */
export function asTree(files: TreeLike): Tree {
  const entries = files instanceof Map ? [...files] : Object.entries(files);
  return new Map(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Copies regular files and directories; destination is created if needed. */
export async function copyTree(
  source: string,
  destination: string,
): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = `${source}/${entry.name}`;
    const to = `${destination}/${entry.name}`;
    if (entry.isDirectory) await copyTree(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
    else throw new Error(`unsupported fixture entry ${from}`);
  }
}

/** Reads every regular file beneath a directory into a sorted tree. */
export async function readTree(directory: string): Promise<Tree> {
  const files: [string, Uint8Array][] = [];
  async function walk(path: string, prefix: string): Promise<void> {
    for await (const entry of Deno.readDir(path)) {
      const name = `${prefix}${entry.name}`;
      const entryPath = `${path}/${entry.name}`;
      if (entry.isDirectory) await walk(entryPath, `${name}/`);
      else if (entry.isFile) files.push([name, await Deno.readFile(entryPath)]);
      else throw new Error(`unexpected entry ${entryPath}`);
    }
  }
  await walk(directory, "");
  return asTree(new Map(files));
}

/** Writes a tree beneath a directory, creating intermediate directories. */
export async function writeTree(
  directory: string,
  files: TreeLike,
): Promise<void> {
  for (const [name, bytes] of asTree(files)) {
    const path = `${directory}/${name}`;
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeFile(path, bytes);
  }
}
