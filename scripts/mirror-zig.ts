// Stage, verify, and lock the project's mirror release of the pinned Zig
// toolchain.
//
// ziglang.org prunes development builds, and the pinned generator toolchain
// (the `zig` line of mise.toml, matching ref/capnp-zig/mise.toml) is one. The
// project keeps the Zig Software Foundation's signed tarballs in its own
// GitHub release, `toolchain-zig-<version>`. mise's core:zig backend never
// downloads the url recorded in mise.lock: it requests
// https://ziglang.org/builds/<file> and then <file>.minisig from the same host.
// mise.toml therefore turns the Zig community mirrors off and redirects those
// requests to the release with a `url_replacements` rule; mise still verifies
// the ZSF minisign signature and the sha256 that mise.lock records. This script
// applies that rule the way mise does, so the lock entries it writes name the
// URLs mise actually fetches. Uploading a release is a human action; this
// script prepares the files, prints the commands, and verifies the result.
//
// Usage (`mise run mirror:zig -- <command>`):
//   stage               download the four tarballs and their .minisig files
//                       into build/mirror/zig/<version>/, verify every
//                       signature (and the mise.lock checksums when the lock
//                       records this version), write SHA256SUMS and NOTES.md,
//                       and print the gh command that publishes the release
//   check               offline (`mise run check:zig-lock`, part of lint):
//                       mise.toml turns the community mirrors off and its
//                       url_replacements send every tarball and .minisig
//                       request to the mirror release, and every zig entry of
//                       mise.lock names that URL with a sha256 and minisign
//                       provenance; warns about local overrides of those
//                       settings (MISE_URL_REPLACEMENTS, MISE_SAFE,
//                       mise.local.toml)
//   verify              check, then download from the release: it serves a
//                       tarball and a .minisig that verify against the ZSF
//                       key and match the locked sha256
//   verify <base-url>   fetch every file from <base-url>/<name> (renamed asset
//                       names are tried as well) and verify the signatures,
//                       and the checksums when the lock records this version
//   lock [--write]      print the mise.lock zig platform entries for the pinned
//                       version from what the mirror release serves, verified
//                       against the ZSF key; --write replaces them in mise.lock.
//                       After a pin bump, run `mise lock zig` first (it writes
//                       the new version's entries with ziglang.org URLs and no
//                       checksums), then this.
//
// stage takes each file from build/mirror when present, else from the first
// of: the mirror release, the URL in mise.lock, ziglang.org, and every
// community mirror listed at https://ziglang.org/download/community-mirrors.txt.
// Every file is verified before it is used, whatever its source.
import { createHash } from "node:crypto";
import { sha256 } from "./verify-release.ts";

const zigPublicKey = "RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U";
const mirrorListUrl = "https://ziglang.org/download/community-mirrors.txt";
const repository = "nullstyle/capnpc-wasm";
// core:zig appends this query to every mirror and signature request.
const miseRequestSuffix = "?source=mise-en-place";
const platforms = {
  "linux-arm64": { arch: "aarch64", os: "linux" },
  "linux-x64": { arch: "x86_64", os: "linux" },
  "macos-arm64": { arch: "aarch64", os: "macos" },
  "macos-x64": { arch: "x86_64", os: "macos" },
} as const;
type Platform = keyof typeof platforms;
type LockEntry = { url?: string; checksum?: string; provenance?: string };
type Rule = { pattern: string; replacement: string };
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
    "usage: scripts/mirror-zig.ts stage | check | verify [<base-url>] | lock [--write]",
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

// The URL core:zig requests for a version it cannot find in ziglang.org's
// index: development builds live under /builds/.
function upstreamUrl(version: string, file: string): string {
  return version.includes("-dev.")
    ? `https://ziglang.org/builds/${file}`
    : `https://ziglang.org/download/${version}/${file}`;
}

function releaseBase(version: string): string {
  return `https://github.com/${repository}/releases/download/toolchain-zig-${version}`;
}

function tomlKey(raw: string): string {
  if (raw.startsWith("'")) return raw.slice(1, -1);
  return JSON.parse(raw);
}

// The `[settings.url_replacements]` table of mise.toml, in order.
function urlReplacements(toml: string): Rule[] {
  const table = toml.match(
    /^\[settings\.url_replacements\]\n((?:(?!\[)[^\n]*\n)*)/m,
  );
  if (!table) return [];
  const rules: Rule[] = [];
  for (const line of table[1].split("\n")) {
    const match = line.match(
      /^('[^']*'|"(?:[^"\\]|\\.)*")\s*=\s*("(?:[^"\\]|\\.)*")\s*$/,
    );
    if (match) {
      rules.push({
        pattern: tomlKey(match[1]),
        replacement: tomlKey(match[2]),
      });
    }
  }
  return rules;
}

// Rust regex replacement syntax: $name, ${name}, $n, ${n}, and $$.
function expand(replacement: string, groups: (string | undefined)[]): string {
  return replacement.replace(
    /\$\$|\$\{([^}]*)\}|\$([A-Za-z0-9_]+)/g,
    (token, braced?: string, bare?: string) => {
      if (token === "$$") return "$";
      const name = braced ?? bare ?? "";
      return /^\d+$/.test(name) ? groups[Number(name)] ?? "" : "";
    },
  );
}

// mise's apply_url_replacements: the first rule that changes the URL wins; a
// `regex:` rule replaces its first match, any other rule every occurrence.
function applyRules(url: string, rules: Rule[]): string {
  for (const { pattern, replacement } of rules) {
    let replaced: string;
    if (pattern.startsWith("regex:")) {
      const regex = new RegExp(pattern.slice("regex:".length));
      const match = regex.exec(url);
      if (!match) continue;
      replaced = url.slice(0, match.index) +
        expand(replacement, [...match]) +
        url.slice(match.index + match[0].length);
    } else {
      replaced = url.replaceAll(pattern, replacement);
    }
    if (replaced !== url) return replaced;
  }
  return url;
}

// A table of mise.toml: the lines after its header, up to the next header.
function tomlTable(toml: string, name: string): string {
  const header = name.replaceAll(".", "\\.");
  return toml.match(
    new RegExp(`^\\[${header}\\]\\n((?:(?!\\[)[^\\n]*\\n)*)`, "m"),
  )?.[1] ?? "";
}

// The zig.use_community_mirrors value mise.toml sets, in any TOML spelling:
// a [settings.zig] table, a dotted key, or an inline table in [settings].
function communityMirrors(toml: string): string | undefined {
  const settings = tomlTable(toml, "settings");
  return tomlTable(toml, "settings.zig").match(
    /^use_community_mirrors\s*=\s*(\w+)/m,
  )?.[1] ??
    settings.match(/^zig\.use_community_mirrors\s*=\s*(\w+)/m)?.[1] ??
    settings.match(/^zig\s*=\s*\{[^}]*use_community_mirrors\s*=\s*(\w+)/m)
      ?.[1];
}

// The [[tools.zig]] section of mise.lock, when it records `version`.
function lockSection(lock: string, version: string): string | undefined {
  const start = lock.indexOf(`[[tools.zig]]\nversion = "${version}"\n`);
  if (start < 0) return undefined;
  const next = lock.indexOf("\n[[", start + 1);
  return lock.slice(start, next < 0 ? undefined : next + 1);
}

// The platform entries of a [[tools.zig]] section.
function lockEntries(section: string | undefined): Map<Platform, LockEntry> {
  const entries = new Map<Platform, LockEntry>();
  if (!section) return entries;
  for (
    const block of section.matchAll(
      /\[tools\.zig\."platforms\.([a-z0-9-]+)"\]\n((?:[a-z_]+ = .*\n)*)/g,
    )
  ) {
    entries.set(block[1] as Platform, {
      url: block[2].match(/^url = "([^"]+)"$/m)?.[1],
      checksum: block[2].match(/^checksum = "([^"]+)"$/m)?.[1],
      provenance: block[2].match(/^provenance = "([^"]+)"$/m)?.[1],
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

// Three attempts on a network error, 429, or 5xx (GitHub's release downloads
// return an occasional transient 500); any other status fails at once.
async function fetchBytes(url: string): Promise<Uint8Array | undefined> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let retry = false;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(600_000),
      });
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
      await response.body?.cancel();
      console.error(`  ${url}: HTTP ${response.status}`);
      retry = response.status === 429 || response.status >= 500;
    } catch (error) {
      console.error(`  ${url}: ${error}`);
      retry = true;
    }
    if (!retry || attempt === 3) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
  }
  return undefined;
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

// Local settings that silently undo mise.toml's Zig redirect. mise does not
// merge url_replacements tables: the environment variable or a table in
// mise.local.toml replaces the project's, and MISE_SAFE ignores project
// settings altogether.
async function overrideWarnings(): Promise<string[]> {
  const warnings: string[] = [];
  const effects: Record<string, string> = {
    MISE_URL_REPLACEMENTS:
      "replaces mise.toml's url_replacements, so mise requests the pruned ziglang.org URL",
    MISE_ZIG_USE_COMMUNITY_MIRRORS:
      "overrides mise.toml's zig.use_community_mirrors",
    MISE_SAFE:
      "makes mise ignore mise.toml's settings, so Zig comes from the (still verified) community mirrors",
  };
  for (const [name, effect] of Object.entries(effects)) {
    if (Deno.env.get(name) !== undefined) warnings.push(`${name} ${effect}`);
  }
  for (const path of ["mise.local.toml", ".mise.local.toml"]) {
    const bytes = await readIfPresent(path);
    const text = bytes ? new TextDecoder().decode(bytes) : "";
    if (/url_replacements/.test(text)) {
      warnings.push(
        `${path} sets url_replacements, which replace mise.toml's table and drop the Zig rule`,
      );
    }
    if (/use_community_mirrors/.test(text)) {
      warnings.push(
        `${path} sets zig.use_community_mirrors, which overrides mise.toml's`,
      );
    }
  }
  return warnings;
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

// Download a tarball and its signature from the URLs mise uses and verify them.
async function fetchVerified(
  platform: Platform,
  file: string,
  tarballUrl: string,
  signatureSource: string,
  expectedChecksum: string | undefined,
): Promise<Verified | undefined> {
  const bytes = await fetchBytes(tarballUrl);
  if (!bytes) return undefined;
  const signature = await fetchBytes(signatureSource);
  if (!signature) return undefined;
  return verified(
    platform,
    file,
    tarballUrl,
    bytes,
    new TextDecoder().decode(signature),
    expectedChecksum,
  );
}

function lockBlock(platform: Platform, digest: string, url: string): string {
  return [
    `[tools.zig."platforms.${platform}"]`,
    `checksum = "sha256:${digest}"`,
    `url = "${url}"`,
    `provenance = "minisign"`,
    "",
  ].join("\n");
}

const command = Deno.args[0];
if (!command || !["stage", "check", "verify", "lock"].includes(command)) {
  usage();
}
const toml = await Deno.readTextFile("mise.toml");
const version = pinnedVersion(toml);
const rules = urlReplacements(toml);
const lock = await Deno.readTextFile("mise.lock");
const section = lockSection(lock, version);
const entries = lockEntries(section);
const staging = `build/mirror/zig/${version}`;
const tag = `toolchain-zig-${version}`;
const keys = Object.keys(platforms) as Platform[];

// What core:zig requests for a platform, after mise.toml's url_replacements.
function miseUrls(platform: Platform) {
  const file = fileName(version, platform);
  const upstream = upstreamUrl(version, file);
  return {
    file,
    upstream,
    tarball: applyRules(upstream, rules),
    signature: applyRules(`${upstream}.minisig${miseRequestSuffix}`, rules),
  };
}

// mise.toml must send every core:zig request to the mirror release: with the
// community mirrors on, core:zig tries a random mirror before the redirected
// URL and trusts that mirror for the .minisig too.
function configProblems(): string[] {
  const problems: string[] = [];
  const mirrors = communityMirrors(toml);
  if (mirrors !== "false") {
    problems.push(
      `mise.toml must set [settings.zig] use_community_mirrors = false (it sets ${
        mirrors ?? "nothing"
      }): with the mirrors on, core:zig takes the tarball and its .minisig from a randomly chosen community mirror`,
    );
  }
  for (const platform of keys) {
    const { file, upstream, tarball, signature } = miseUrls(platform);
    const release = `${releaseBase(version)}/${file}`;
    if (tarball !== release || signature !== `${release}.minisig`) {
      problems.push(
        `${platform}: mise.toml's url_replacements send ${upstream} to ${tarball} and its signature to ${signature}, not to ${release} and its .minisig`,
      );
    }
  }
  return problems;
}

// Every zig entry of mise.lock must name the URL mise fetches and pin it.
function lockProblems(): string[] {
  if (!section) {
    return [
      `mise.lock records no zig ${version}; run \`mise lock zig\`, then \`mise run mirror:zig -- lock --write\``,
    ];
  }
  const problems: string[] = [];
  if (!/^backend = "core:zig"$/m.test(section)) {
    problems.push(`mise.lock records zig ${version} with another backend`);
  }
  for (const platform of keys) {
    const { file, tarball } = miseUrls(platform);
    const entry = entries.get(platform);
    if (!entry) {
      problems.push(`${platform}: mise.lock has no zig ${version} entry`);
      continue;
    }
    const rewrite = "run `mise run mirror:zig -- lock --write`";
    if (entry.url !== tarball) {
      problems.push(
        `${platform}: mise.lock names ${
          entry.url ?? "no url"
        }, but mise downloads ${tarball}; ${rewrite}`,
      );
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(entry.checksum ?? "")) {
      problems.push(
        `${platform}: mise.lock records no sha256 for ${file} (${
          entry.checksum ?? "no checksum"
        }); ${rewrite}`,
      );
    }
    if (entry.provenance !== "minisign") {
      problems.push(
        `${platform}: mise.lock does not require minisign provenance for ${file}; ${rewrite}`,
      );
    }
  }
  return problems;
}

if (command === "stage") {
  await Deno.mkdir(staging, { recursive: true });
  const results: Verified[] = [];
  for (const platform of keys) {
    const { file, tarball } = miseUrls(platform);
    const expected = entries.get(platform)?.checksum;
    let result: Verified | undefined;
    const staged = await readIfPresent(`${staging}/${file}`);
    const stagedSignature = await readIfPresent(`${staging}/${file}.minisig`);
    if (staged && stagedSignature) {
      result = await verified(
        platform,
        file,
        `${staging}/${file}`,
        staged,
        new TextDecoder().decode(stagedSignature),
        expected,
      );
    }
    const lockUrl = entries.get(platform)?.url;
    const sources = result ? [] : [
      `${releaseBase(version)}/${file}`,
      tarball,
      ...(lockUrl ? [lockUrl] : []),
      upstreamUrl(version, file),
      ...(await mirrors()).map((mirror) =>
        `${mirror}/${file}?source=capnpc-wasm`
      ),
    ];
    for (const url of new Set(sources)) {
      if (result) break;
      console.log(`fetching ${file} from ${url}`);
      result = await fetchVerified(
        platform,
        file,
        url,
        signatureUrl(url),
        expected,
      );
    }
    if (!result) throw new Error(`no source serves ${file} with its signature`);
    if (!result.source.startsWith(staging)) {
      await Deno.writeFile(`${staging}/${result.file}`, result.bytes);
      await Deno.writeTextFile(
        `${staging}/${result.file}.minisig`,
        result.signature,
      );
    }
    console.log(
      `OK ${result.file}: minisign verified, sha256 ${result.sha256}${
        expected ? " matches mise.lock" : " (mise.lock records no checksum)"
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
      "ziglang.org prunes development builds; mise installs these files instead,",
      "through the `url_replacements` rule in mise.toml. They were verified against",
      "the Zig Software Foundation minisign key before upload, and every tarball's",
      "`.minisig` verifies against it:",
      "",
      "```sh",
      `minisign -Vm <tarball> -P ${zigPublicKey}`,
      "```",
      "",
      "The asset names keep the `+` of the version; download URLs accept it as is",
      "or as `%2B`.",
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
  const { tarball } = miseUrls(keys[0]);
  if (!tarball.startsWith(`${releaseBase(version)}/`)) {
    console.log(
      `warning: mise.toml's url_replacements send mise to ${tarball}, not to ${
        releaseBase(version)
      }/`,
    );
  }
  console.log("Publish them (a human action) with:");
  console.log(
    `  gh release create ${tag} --repo ${repository} --prerelease --title "Zig toolchain mirror ${version}" --notes-file ${staging}/NOTES.md \\`,
  );
  console.log(
    `    ${staging}/zig-*.tar.xz ${staging}/zig-*.tar.xz.minisig ${staging}/SHA256SUMS`,
  );
  console.log("then verify the published copies and record them with:");
  console.log(`  mise run mirror:zig -- verify ${releaseBase(version)}`);
  console.log(
    "  mise lock zig                         # only after a pin bump",
  );
  console.log("  mise run mirror:zig -- lock --write");
  console.log("  mise run mirror:zig -- verify");
} else if (command === "verify" && Deno.args[1]) {
  const base = Deno.args[1].replace(/\/$/, "");
  if (Deno.args.length > 2) usage();
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
} else if (command === "check") {
  if (Deno.args.length > 1) usage();
  const problems = [...configProblems(), ...lockProblems()];
  for (const problem of problems) console.log(`FAIL ${problem}`);
  for (const warning of await overrideWarnings()) {
    console.log(`warning: ${warning}`);
  }
  if (problems.length > 0) Deno.exit(1);
  console.log(
    `zig ${version}: mise.toml sends core:zig to ${
      releaseBase(version)
    } with the community mirrors off, and mise.lock pins all ${keys.length} platforms there with a sha256 and minisign provenance`,
  );
} else if (command === "verify") {
  let failed = false;
  const fail = (message: string) => {
    console.log(`FAIL ${message}`);
    failed = true;
  };
  for (const problem of [...configProblems(), ...lockProblems()]) {
    fail(problem);
  }
  for (const warning of await overrideWarnings()) {
    console.log(`warning: ${warning}`);
  }
  for (const platform of keys) {
    const { file, tarball, signature } = miseUrls(platform);
    const entry = entries.get(platform);
    // Missing or mismatched entries are reported above.
    if (!entry?.checksum || entry.url !== tarball) continue;
    try {
      const result = await fetchVerified(
        platform,
        file,
        tarball,
        signature,
        entry.checksum,
      );
      if (!result) {
        fail(`${platform}: ${tarball} or its .minisig is not served`);
        continue;
      }
      console.log(
        `OK ${platform}: ${tarball} and its .minisig verify against the ZSF key and match mise.lock (sha256 ${result.sha256})`,
      );
    } catch (error) {
      fail(`${platform}: ${error}`);
    }
  }
  if (failed) Deno.exit(1);
} else {
  const write = Deno.args[1] === "--write";
  if (Deno.args.length > (write ? 2 : 1)) usage();
  // Lock entries are only meaningful for the URLs mise actually fetches.
  const problems = configProblems();
  if (problems.length > 0) {
    throw new Error(`fix mise.toml first:\n${problems.join("\n")}`);
  }
  if (entries.size === 0) {
    throw new Error(
      `mise.lock does not record zig ${version}; run \`mise lock zig\` first`,
    );
  }
  const blocks = new Map<Platform, string>();
  for (const platform of keys) {
    const { file, tarball, signature } = miseUrls(platform);
    console.log(`fetching ${file} from ${tarball}`);
    const result = await fetchVerified(
      platform,
      file,
      tarball,
      signature,
      undefined,
    );
    if (!result) {
      throw new Error(
        `${tarball} or its .minisig is not served: stage and upload the mirror release first (\`mise run mirror:zig -- stage\` prints the command)`,
      );
    }
    blocks.set(platform, lockBlock(platform, result.sha256, tarball));
  }
  console.log([...blocks.values()].join("\n"));
  if (write) {
    const start = lock.indexOf(`[[tools.zig]]\nversion = "${version}"\n`);
    const next = lock.indexOf("\n[[", start + 1);
    const end = next < 0 ? lock.length : next + 1;
    let section = lock.slice(start, end);
    for (const [platform, block] of blocks) {
      const pattern = new RegExp(
        `\\[tools\\.zig\\."platforms\\.${platform}"\\]\\n(?:[a-z_]+ = .*\\n)*`,
      );
      if (!pattern.test(section)) {
        throw new Error(
          `mise.lock has no zig entry for ${platform}; run \`mise lock zig\` first`,
        );
      }
      section = section.replace(pattern, () => block);
    }
    await Deno.writeTextFile(
      "mise.lock",
      lock.slice(0, start) + section + lock.slice(end),
    );
    console.log("updated the zig entries in mise.lock");
  }
}
