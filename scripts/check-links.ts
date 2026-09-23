// Check relative links and heading anchors in Markdown files outside ref/.
// Usage: deno run --allow-read scripts/check-links.ts [file.md ...]
// External links (http, https, mailto) are not fetched. Links inside fenced
// code blocks and inline code spans are ignored.

const skipped = new Set([
  ".cache",
  ".git",
  "build",
  "dist",
  "node_modules",
  "ref",
]);

async function markdownFiles(
  directory: string,
  prefix = "",
): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isDirectory) {
      if (skipped.has(entry.name)) continue;
      found.push(
        ...await markdownFiles(
          `${directory}/${entry.name}`,
          `${prefix}${entry.name}/`,
        ),
      );
    } else if (entry.isFile && entry.name.endsWith(".md")) {
      found.push(`${prefix}${entry.name}`);
    }
  }
  return found.sort();
}

type Link = { line: number; target: string };
type Document = { headings: Set<string>; links: Link[] };

// GitHub heading anchors: lowercase, drop punctuation other than hyphens,
// spaces become hyphens, and repeated slugs gain a numeric suffix.
function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/ /g, "-");
}

function parse(source: string): Document {
  const headings = new Set<string>();
  const counts = new Map<string, number>();
  const links: Link[] = [];
  let fenced = false;
  source.split("\n").forEach((raw, index) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(raw);
    if (heading) {
      const base = slug(heading[1]);
      const seen = counts.get(base) ?? 0;
      counts.set(base, seen + 1);
      headings.add(seen === 0 ? base : `${base}-${seen}`);
    }
    const line = raw.replace(/`[^`]*`/g, "");
    for (
      const match of line.matchAll(
        /\[[^\]]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g,
      )
    ) {
      links.push({ line: index + 1, target: match[1] });
    }
  });
  return { headings, links };
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

const cache = new Map<string, Document | undefined>();
async function document(path: string): Promise<Document | undefined> {
  if (!cache.has(path)) {
    cache.set(
      path,
      await Deno.readTextFile(path).then(parse).catch(() => undefined),
    );
  }
  return cache.get(path);
}

const files = Deno.args.length > 0
  ? Deno.args.map(normalize)
  : await markdownFiles(".");
const failures: string[] = [];
let checked = 0;
for (const file of files) {
  const doc = await document(file);
  if (!doc) {
    failures.push(`${file}: cannot read`);
    continue;
  }
  const directory = file.includes("/")
    ? file.slice(0, file.lastIndexOf("/"))
    : "";
  for (const { line, target } of doc.links) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    checked += 1;
    const hash = target.indexOf("#");
    const path = hash === -1 ? target : target.slice(0, hash);
    const anchor = hash === -1 ? "" : target.slice(hash + 1);
    const resolved = path === ""
      ? file
      : path.startsWith("/")
      ? normalize(path)
      : normalize(`${directory}/${path}`);
    const stat = await Deno.stat(resolved).catch(() => undefined);
    if (!stat) {
      failures.push(`${file}:${line}: missing target ${target}`);
      continue;
    }
    if (anchor && stat.isFile && resolved.endsWith(".md")) {
      const linked = await document(resolved);
      if (!linked?.headings.has(anchor.toLowerCase())) {
        failures.push(`${file}:${line}: missing anchor ${target}`);
      }
    }
  }
}
for (const failure of failures) console.error(failure);
console.log(
  `Checked ${checked} relative links in ${files.length} Markdown files.`,
);
if (failures.length > 0) {
  console.error(`${failures.length} broken links.`);
  Deno.exit(1);
}
