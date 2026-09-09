// Playwright's Node ZIP extractor stalls under the pinned Deno release. Keep
// Playwright authoritative for platform/revision selection, but extract its
// official archives with the already-managed CMake binary.
import { fileURLToPath } from "node:url";
import { selectedEngines } from "./engines.ts";

const root = Deno.cwd();
const cache = `${root}/.cache/playwright`;
const config = new URL("./deno.json", import.meta.url);
const plan = await new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    "--config",
    fileURLToPath(config),
    "--frozen",
    "--allow-read",
    "--allow-env",
    "--allow-sys",
    fileURLToPath(new URL("./playwright.ts", import.meta.url)),
    "install",
    ...selectedEngines(Deno.args),
    "--only-shell",
    "--dry-run",
  ],
  env: { PLAYWRIGHT_BROWSERS_PATH: cache },
  stdout: "piped",
  stderr: "piped",
}).output();
if (!plan.success) throw new Error(new TextDecoder().decode(plan.stderr));

const items = new TextDecoder().decode(plan.stdout).trim().split(/\n\s*\n/)
  .map((block) => ({
    name: block.split("\n")[0],
    directory: block.match(/Install location:\s*(.+)/)?.[1],
    urls: [
      ...block.matchAll(/Download (?:url|fallback \d+):\s*(https:\/\/\S+)/g),
    ]
      .map((match) => match[1]),
  }));
if (items.length === 0) {
  throw new Error("Playwright returned no browser downloads");
}
await Deno.mkdir(cache, { recursive: true });

for (const item of items) {
  const directory = item.directory;
  if (!directory?.startsWith(`${cache}/`) || item.urls.length === 0) {
    throw new Error(
      `Unexpected Playwright download plan: ${JSON.stringify(item)}`,
    );
  }
  try {
    await Deno.stat(`${directory}/INSTALLATION_COMPLETE`);
    console.log(`${item.name} already installed`);
    continue;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const staging = await Deno.makeTempDir({ dir: cache, prefix: "install-" });
  const archive = `${staging}/download.zip`;
  const unpacked = `${staging}/unpacked`;
  try {
    let downloaded = false;
    for (const url of item.urls) {
      try {
        console.log(`Downloading ${item.name} from ${url}`);
        const response = await fetch(url, {
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status} downloading ${url}`);
        }
        const file = await Deno.open(archive, {
          create: true,
          truncate: true,
          write: true,
        });
        await response.body.pipeTo(file.writable);
        downloaded = true;
        break;
      } catch (error) {
        console.error(String(error));
      }
    }
    if (!downloaded) throw new Error(`Could not download ${item.name}`);
    await Deno.mkdir(unpacked);
    const extracted = await new Deno.Command("cmake", {
      args: ["-E", "tar", "xf", archive],
      cwd: unpacked,
    }).output();
    if (!extracted.success) {
      throw new Error(new TextDecoder().decode(extracted.stderr));
    }
    await Deno.writeTextFile(`${unpacked}/INSTALLATION_COMPLETE`, "");
    try {
      await Deno.remove(directory, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await Deno.rename(unpacked, directory);
    console.log(`Installed ${item.name} at ${directory}`);
  } finally {
    await Deno.remove(staging, { recursive: true });
  }
}
