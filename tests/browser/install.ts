// Playwright's Node ZIP extractor stalls under the pinned Deno release. Keep
// Playwright authoritative for platform/revision selection, but extract its
// official archives with the already-managed CMake binary, and only after the
// archive's sha256 matches the digest recorded below.
//
// Playwright publishes no checksums for its browser builds, so the digests are
// recorded here for the platforms this project tests: Linux and macOS, x64 and
// arm64, keyed by the archive path Playwright selects (WebKit's names the macOS
// release). An archive without a recorded digest, or with a different one, is
// never extracted. After a Playwright bump in tests/browser/deno.json, print
// the new revisions' digests with `mise run browser:install -- --print-digests`
// on each platform (or `curl -sSfL <url> | shasum -a 256` for the archive paths
// of the other platforms), confirm them against a second download, and record
// them here.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectedEngines } from "./engines.ts";

// Keyed by the archive path below Playwright's download hosts, from `builds/`.
const digests: Record<string, string> = {
  "builds/cft/153.0.8010.12/linux64/chrome-headless-shell-linux64.zip":
    "a9da028861a0cf789ff25c2fed45f5f1aaf969ed9247835b6a7821a4f7af9d1d",
  "builds/cft/153.0.8010.12/linux-arm64/chrome-headless-shell-linux-arm64.zip":
    "d433c45172c7836e38124fe545f767b02210bfb43a6262f08a297473a8e91c99",
  "builds/cft/153.0.8010.12/mac-x64/chrome-headless-shell-mac-x64.zip":
    "5c2eaa1aad62111bb5a70dd0889dd3093f3142277b8f78957a238257ee85f009",
  "builds/cft/153.0.8010.12/mac-arm64/chrome-headless-shell-mac-arm64.zip":
    "89d80a6d26ccd0ccfd51e22d9e1297283862af2b0cd91dce07459b35ca0059f2",
  "builds/firefox/1543/firefox-ubuntu-24.04.zip":
    "b0905e84427cc162b9a6e4392be14e5e54e0ade911c83639962c8078b273565e",
  "builds/firefox/1543/firefox-ubuntu-24.04-arm64.zip":
    "10a0c716eb93ee7e57aabf8d626bd35b5c4007517c90708f67634f640a47a569",
  "builds/firefox/1543/firefox-mac.zip":
    "717693ae50e22f6070895a73bc5546dc862ffdf87e6ba9892a5f9e423b312741",
  "builds/firefox/1543/firefox-mac-arm64.zip":
    "12798eac57cad33a466d7315ddae1350a326dedd167ee4ac73307425f4fa8f28",
  "builds/webkit/2359/webkit-ubuntu-24.04.zip":
    "8c129d989a1c48d826ca11b45acbba919039de811623dc3819ccbd95b69eeb62",
  "builds/webkit/2359/webkit-ubuntu-24.04-arm64.zip":
    "01e84b5cc2b4e4a39ded958c0fe464bd0a156d9a0fe3af053cf4cf3fce3b6116",
  "builds/webkit/2359/webkit-mac-15.zip":
    "b9d6206ef34cb6d764f7c9abf7b8fa94fa130947bc5d98ddbe52f011aa72792d",
  "builds/webkit/2359/webkit-mac-15-arm64.zip":
    "33902c98fc0442f916eaa1e006af775f03c65c554eacba78e446581ba2f71ffd",
  "builds/webkit/2359/webkit-mac-26.zip":
    "7b661e131cc479145ba6e18495c945b7fb9447e87857982e3a433c3232a7546a",
  "builds/webkit/2359/webkit-mac-26-arm64.zip":
    "f0c43ff8a566ef9cf57b5c0e349d985c60e6ffeb7416e8aac34a5c911bbb8ca7",
  "builds/ffmpeg/1011/ffmpeg-linux.zip":
    "ebc74fc5b94830176a3c2914ae96bd8bc7f6a91f4f33890230f84a172ee61ccc",
  "builds/ffmpeg/1011/ffmpeg-linux-arm64.zip":
    "2628c03f05318ff812c8c9baaf207dea2ddf53e818c0dc936714b0fbe3afb009",
  "builds/ffmpeg/1011/ffmpeg-mac.zip":
    "17ed15a2fa60d3c74181befcb2bdf7c9bb288d19b2a3b9893b94b63f2ce260e4",
  "builds/ffmpeg/1011/ffmpeg-mac-arm64.zip":
    "7d77eb0d44b59acc4065faa2476c0df1a242cc904c346f820626818c953c5277",
};

class DigestMismatchError extends Error {}

function digestKey(url: string): string {
  const path = new URL(url).pathname;
  const index = path.indexOf("/builds/");
  return index >= 0 ? path.slice(index + 1) : path.slice(1);
}

// Stream the archive to `destination` (or discard it) while hashing it.
async function download(
  url: string,
  destination: string | undefined,
): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} downloading ${url}`);
  }
  const hash = createHash("sha256");
  const hashing = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      hash.update(chunk);
      controller.enqueue(chunk);
    },
  });
  const sink = destination
    ? (await Deno.open(destination, {
      create: true,
      truncate: true,
      write: true,
    })).writable
    : new WritableStream<Uint8Array>();
  await response.body.pipeThrough(hashing).pipeTo(sink);
  return hash.digest("hex");
}

const printDigests = Deno.args.includes("--print-digests");
const engineArguments = Deno.args.filter((argument) =>
  argument !== "--print-digests"
);

// mise.toml sets PLAYWRIGHT_BROWSERS_PATH to the project cache; mise.local.toml
// can point it at a cache shared between worktrees. Playwright reads the same
// variable at run time, so installation and use agree on the location.
const root = Deno.cwd();
const cache = resolve(
  Deno.env.get("PLAYWRIGHT_BROWSERS_PATH") ?? `${root}/.cache/playwright`,
);
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
    ...selectedEngines(engineArguments),
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

if (printDigests) {
  // Download each archive once, without extracting or installing anything.
  for (const item of items) {
    let printed = false;
    for (const url of item.urls) {
      try {
        const digest = await download(url, undefined);
        console.log(`  "${digestKey(url)}":\n    "${digest}",`);
        printed = true;
        break;
      } catch (error) {
        console.error(String(error));
      }
    }
    if (!printed) throw new Error(`Could not download ${item.name}`);
  }
  Deno.exit(0);
}

await Deno.mkdir(cache, { recursive: true });

for (const item of items) {
  const directory = item.directory;
  if (!directory?.startsWith(`${cache}/`) || item.urls.length === 0) {
    throw new Error(
      `Unexpected Playwright download plan: ${JSON.stringify(item)}`,
    );
  }
  for (const url of item.urls) {
    if (!digests[digestKey(url)]) {
      throw new Error(
        `No recorded digest for ${item.name} archive ${
          digestKey(url)
        }: verify it independently and record it in tests/browser/install.ts (--print-digests prints it)`,
      );
    }
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
        const digest = await download(url, archive);
        const expected = digests[digestKey(url)];
        if (digest !== expected) {
          // Every fallback serves the same archive: different bytes are a
          // reason to stop, not to try the next host.
          throw new DigestMismatchError(
            `${item.name} archive ${
              digestKey(url)
            } has sha256 ${digest}, expected ${expected}`,
          );
        }
        console.log(`Verified ${item.name} sha256 ${digest}`);
        downloaded = true;
        break;
      } catch (error) {
        if (error instanceof DigestMismatchError) throw error;
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
