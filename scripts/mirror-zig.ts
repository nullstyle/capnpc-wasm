// Prepare, verify, and record checksums for a project-owned mirror of the
// pinned Zig toolchain.
//
// ziglang.org prunes development builds, and the pinned generator toolchain
// (the `zig` line of mise.toml, matching ref/capnp-zig/mise.toml) is one. mise
// installs it from the Zig community mirrors, verifies the Zig Software
// Foundation minisign signature, and checks the sha256 recorded in mise.lock.
// A project-owned copy keeps the exact bytes available after the community
// mirrors drop the build. Uploading it is a human action; this script prepares
// the files, prints the commands, and verifies the result.
//
// Usage (`mise run mirror:zig -- <command>`):
//   stage               download the four tarballs and their .minisig files
//                       into build/mirror/zig/<version>/, verify every
//                       signature and every mise.lock checksum, write
//                       SHA256SUMS and NOTES.md, and print the gh commands
//                       that publish them as a GitHub release
//   verify <base-url>   fetch every file from <base-url>/<name> (GitHub's
//                       renamed asset names are tried as well) and verify the
//                       signatures and checksums
//   lock [--write]      print the mise.lock zig platform entries for the pinned
//                       version from verified downloads; --write replaces them
//                       in mise.lock. After a pin bump: `mise lock zig` first,
//                       then this, because `mise lock` records no checksum for
//                       a build that ziglang.org no longer lists.
//
// Download sources, in order: files already staged under build/mirror, the URL
// recorded in mise.lock, ziglang.org, then every community mirror listed at
// https://ziglang.org/download/community-mirrors.txt. Every file is verified
// before it is used, whatever its source.
import { createHash } from "node:crypto";
import { sha256 } from "./verify-release.ts";

const zigPublicKey = "RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U";
const mirrorListUrl = "https://ziglang.org/download/community-mirrors.txt";
const repository = "nullstyle/capnpc-wasm";
const platforms = {
  "linux-arm64": { arch: "aarch64", os: "linux" },
  "linux-x64": { arch: "x86_64", os: "linux" },
  "macos-arm64": { arch: "aarch64", os: "macos" },
  "macos-x64": { arch: "x86_64", os: "macos" },
} as const;
type Platform = keyof typeof platforms;
type Verified = {
  platform: Platform;
  file: string;
  source: string;
  bytes: Uint8Array;
  signature: string;
  sha256: string;
};

function usage(): never {
  console.error(
    "usage: scripts/mirror-zig.ts stage | verify <base-url> | lock [--write]",
  );
  Deno.exit(2);
}

function pinnedVersion(toml: string): string {
  const match = toml.match(/^zig = "([^"]+)"$/m);
  if (!match) throw new Error("no zig pin in mise.toml");
  return match[1];
}

function fileName(version: string, platform: Platform): string {
  const { arch, os } = platforms[platform];
  return `zig-${arch}-${os}-${version}.tar.xz`;
}

function upstreamUrl(version: string, file: string): string {
  return version.includes("-dev.")
    ? `https://ziglang.org/builds/${file}`
    : `https://ziglang.org/download/${version}/${file}`;
}

function lockEntries(
  lock: string,
): Map<Platform, { url?: string; checksum?: string }> {
  const entries = new Map<Platform, { url?: string; checksum?: string }>();
  for (
    const block of lock.matchAll(
      /\[tools\.zig\."platforms\.([a-z0-9-]+)"\]\n((?:[a-z_]+ = .*\n)*)/g,
    )
  ) {
    entries.set(block[1] as Platform, {
      url: block[2].match(/^url = "([^"]+)"$/m)?.[1],
      checksum: block[2].match(/^checksum = "([^"]+)"$/m)?.[1],
    });
  }
  return entries;
}

function base64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
}

// Minisign: 42-byte public key (algorithm, key id, Ed25519 key), 74-byte
// signature (algorithm, key id, Ed25519 signature) over the file, or over its
// BLAKE2b-512 digest for the "ED" prehashed algorithm, and a global signature
// over the signature followed by the trusted comment, which names the file.
async function verifyMinisign(
  bytes: Uint8Array,
  signature: string,
  expectedFile: string,
): Promise<void> {
  const key = base64(zigPublicKey);
  if (key.length !== 42 || String.fromCharCode(key[0], key[1]) !== "Ed") {
    throw new Error("unexpected minisign public key format");
  }
  const lines = signature.trimEnd().split("\n");
  if (lines.length < 4) throw new Error("malformed minisign signature");
  const fileSignature = base64(lines[1]);
  const globalSignature = base64(lines[3]);
  if (fileSignature.length !== 74 || globalSignature.length !== 64) {
    throw new Error("malformed minisign signature");
  }
  const algorithm = String.fromCharCode(fileSignature[0], fileSignature[1]);
  if (algorithm !== "Ed" && algorithm !== "ED") {
    throw new Error(`unsupported minisign algorithm ${algorithm}`);
  }
  if (
    !key.slice(2, 10).every((byte, index) => byte === fileSignature[2 + index])
  ) {
    throw new Error("minisign key id does not match the ZSF key");
  }
  const publicKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key.slice(10)),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const message = algorithm === "ED"
    ? new Uint8Array(createHash("blake2b512").update(bytes).digest())
    : bytes;
  if (
    !await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      new Uint8Array(fileSignature.slice(10)),
      new Uint8Array(message),
    )
  ) {
    throw new Error("minisign signature does not verify");
  }
  const trusted = lines[2].replace(/^trusted comment: /, "");
  const globalMessage = new Uint8Array([
    ...fileSignature.slice(10),
    ...new TextEncoder().encode(trusted),
  ]);
  if (
    !await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      new Uint8Array(globalSignature),
      globalMessage,
    )
  ) {
    throw new Error("minisign trusted comment does not verify");
  }
  if (!trusted.split("\t").includes(`file:${expectedFile}`)) {
    throw new Error(`signature names another file: ${trusted}`);
  }
}

async function fetchBytes(url: string): Promise<Uint8Array | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok) {
      console.error(`  ${url}: HTTP ${response.status}`);
      return undefined;
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    console.error(`  ${url}: ${error}`);
    return undefined;
  }
}

function signatureUrl(url: string): string {
  return url.replace(/(\?.*)?$/, ".minisig$1");
}

let mirrorList: string[] | undefined;
async function mirrors(): Promise<string[]> {
  if (!mirrorList) {
    const text = new TextDecoder().decode(await fetchBytes(mirrorListUrl));
    mirrorList = text.split("\n").map((line) => line.trim()).filter((line) =>
      line.startsWith("https://")
    );
  }
  return mirrorList;
}

async function readIfPresent(path: string): Promise<Uint8Array | undefined> {
  try {
    return await Deno.readFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function verified(
  platform: Platform,
  file: string,
  source: string,
  bytes: Uint8Array,
  signature: string,
  expectedChecksum: string | undefined,
): Promise<Verified> {
  await verifyMinisign(bytes, signature, file);
  const digest = await sha256(bytes);
  if (expectedChecksum && expectedChecksum !== `sha256:${digest}`) {
    throw new Error(
      `${file} from ${source}: sha256 ${digest} differs from mise.lock ${expectedChecksum}`,
    );
  }
  return { platform, file, source, bytes, signature, sha256: digest };
}

// Obtain a verified tarball: from the staging directory when present, else
// from the first source that serves both the tarball and its signature.
async function obtain(
  platform: Platform,
  version: string,
  staging: string,
  lockUrl: string | undefined,
  expectedChecksum: string | undefined,
): Promise<Verified> {
  const file = fileName(version, platform);
  const staged = await readIfPresent(`${staging}/${file}`);
  const stagedSignature = await readIfPresent(`${staging}/${file}.minisig`);
  if (staged && stagedSignature) {
    return verified(
      platform,
      file,
      `${staging}/${file}`,
      staged,
      new TextDecoder().decode(stagedSignature),
      expectedChecksum,
    );
  }
  const sources = [
    ...(lockUrl ? [lockUrl] : []),
    upstreamUrl(version, file),
    ...(await mirrors()).map((mirror) =>
      `${mirror}/${file}?source=capnpc-wasm`
    ),
  ];
  for (const url of new Set(sources)) {
    console.log(`fetching ${file} from ${url}`);
    const bytes = await fetchBytes(url);
    if (!bytes) continue;
    const signature = await fetchBytes(signatureUrl(url));
    if (!signature) continue;
    return verified(
      platform,
      file,
      url,
      bytes,
      new TextDecoder().decode(signature),
      expectedChecksum,
    );
  }
  throw new Error(`no source serves ${file} with its signature`);
}

function lockEntry(entry: Verified, version: string): string {
  return [
    `[tools.zig."platforms.${entry.platform}"]`,
    `checksum = "sha256:${entry.sha256}"`,
    `url = "${upstreamUrl(version, entry.file)}"`,
    `provenance = "minisign"`,
    "",
  ].join("\n");
}

const command = Deno.args[0];
if (!command || !["stage", "verify", "lock"].includes(command)) usage();
const version = pinnedVersion(await Deno.readTextFile("mise.toml"));
const lock = await Deno.readTextFile("mise.lock");
const entries = lockEntries(lock);
const staging = `build/mirror/zig/${version}`;
const tag = `toolchain-zig-${version}`;
const keys = Object.keys(platforms) as Platform[];

if (command === "stage") {
  await Deno.mkdir(staging, { recursive: true });
  const results: Verified[] = [];
  for (const platform of keys) {
    const entry = entries.get(platform);
    const result = await obtain(
      platform,
      version,
      staging,
      entry?.url,
      entry?.checksum,
    );
    if (!result.source.startsWith(staging)) {
      await Deno.writeFile(`${staging}/${result.file}`, result.bytes);
      await Deno.writeTextFile(
        `${staging}/${result.file}.minisig`,
        result.signature,
      );
    }
    console.log(
      `OK ${result.file}: minisign verified, sha256 ${result.sha256}${
        entry?.checksum
          ? " matches mise.lock"
          : " (mise.lock records no checksum)"
      } (${result.source})`,
    );
    results.push(result);
  }
  await Deno.writeTextFile(
    `${staging}/SHA256SUMS`,
    results.map((result) => `${result.sha256}  ${result.file}\n`).join(""),
  );
  await Deno.writeTextFile(
    `${staging}/NOTES.md`,
    [
      `# Zig toolchain mirror ${version}`,
      "",
      "Exact copies of the ziglang.org development build that compiles the pinned",
      "capnp-zig generator (the `zig` pin of mise.toml and ref/capnp-zig/mise.toml).",
      "ziglang.org prunes development builds; these files were verified against the",
      "Zig Software Foundation minisign key before upload, and every tarball's",
      "`.minisig` verifies against it:",
      "",
      "```sh",
      `minisign -Vm <tarball> -P ${zigPublicKey}`,
      "```",
      "",
      "GitHub renames uploaded assets whose names contain `+`. The signature's",
      "trusted comment names the original file, so restore the original name",
      "(from SHA256SUMS) before verifying a downloaded copy.",
      "",
      "| File | SHA-256 | Bytes | Fetched from |",
      "| --- | --- | --- | --- |",
      ...results.map((result) =>
        `| ${result.file} | ${result.sha256} | ${result.bytes.length} | ${result.source} |`
      ),
      "",
    ].join("\n"),
  );
  console.log(`\nstaged ${results.length} tarballs under ${staging}\n`);
  console.log("Publish them (a human action) with:");
  console.log(
    `  gh release create ${tag} --repo ${repository} --title "Zig toolchain mirror ${version}" --notes-file ${staging}/NOTES.md \\`,
  );
  console.log(
    `    ${staging}/zig-*.tar.xz ${staging}/zig-*.tar.xz.minisig ${staging}/SHA256SUMS`,
  );
  console.log("then verify the published copies with:");
  console.log(
    `  mise run mirror:zig -- verify https://github.com/${repository}/releases/download/${tag}`,
  );
} else if (command === "verify") {
  const base = Deno.args[1]?.replace(/\/$/, "");
  if (!base) usage();
  let failed = false;
  for (const platform of keys) {
    const file = fileName(version, platform);
    const candidates = [
      file,
      file.replaceAll("+", "."),
      file.replaceAll("+", "-"),
    ];
    let done = false;
    for (const name of candidates) {
      const bytes = await fetchBytes(`${base}/${name}`);
      if (!bytes) continue;
      const signature = await fetchBytes(`${base}/${name}.minisig`);
      if (!signature) continue;
      try {
        const result = await verified(
          platform,
          file,
          `${base}/${name}`,
          bytes,
          new TextDecoder().decode(signature),
          entries.get(platform)?.checksum,
        );
        console.log(
          `OK ${base}/${name}: minisign verified, sha256 ${result.sha256}`,
        );
      } catch (error) {
        console.log(`FAIL ${base}/${name}: ${error}`);
        failed = true;
      }
      done = true;
      break;
    }
    if (!done) {
      console.log(`FAIL ${base}: no copy of ${file} with its .minisig`);
      failed = true;
    }
  }
  if (failed) Deno.exit(1);
} else {
  const write = Deno.args[1] === "--write";
  if (Deno.args.length > (write ? 2 : 1)) usage();
  if (!lock.includes(`[[tools.zig]]\nversion = "${version}"`)) {
    throw new Error(
      `mise.lock does not record zig ${version}; run \`mise lock zig\` first`,
    );
  }
  const results: Verified[] = [];
  for (const platform of keys) {
    results.push(
      await obtain(
        platform,
        version,
        staging,
        entries.get(platform)?.url,
        undefined,
      ),
    );
  }
  const blocks = results.map((result) => lockEntry(result, version));
  console.log(blocks.join("\n"));
  if (write) {
    let updated = lock;
    for (const result of results) {
      const pattern = new RegExp(
        `\\[tools\\.zig\\."platforms\\.${result.platform}"\\]\\n(?:[a-z_]+ = .*\\n)*`,
      );
      if (!pattern.test(updated)) {
        throw new Error(
          `mise.lock has no zig entry for ${result.platform}; run \`mise lock zig\` first`,
        );
      }
      updated = updated.replace(pattern, lockEntry(result, version));
    }
    await Deno.writeTextFile("mise.lock", updated);
    console.log("updated the zig entries in mise.lock");
  }
}
