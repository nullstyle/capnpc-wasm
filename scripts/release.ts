// Prepare one release-archive flavor from the built dist/ tree: a package/
// directory, its deterministic .tgz, the manifest as a separate asset, an SPDX
// 2.3 software bill of materials, release notes, and SHA256SUMS. Importing
// this module has no side effects; the command line runs under
// import.meta.main, and the package tests import the flavor table from here.
//
// Usage: release.ts [--tools-only | --compiler-host] [--out DIR]
//                   [--allow-dirty] [--allow-existing-tag] [--publish]
//
// Each flavor has its own version, `versions["<flavor>"]` in release.json,
// and its own release tag, `<flavor>-v<version>`; the full SDK's version also
// names the Go module tag, `sdk/go/v<version>`.
//
// Candidate mode (the default, used by the release:* tasks) writes
// DIR/<stem>/ (DIR defaults to dist/releases) and replaces an earlier
// candidate there. It refuses a working tree with uncommitted or untracked
// changes unless --allow-dirty is given, and a flavor version whose release
// tag, or Go module tag, already exists at another commit unless
// --allow-existing-tag is given; neither flag is accepted with --publish.
// Publish mode, which only the release workflow uses, additionally requires
// HEAD to carry the release tag (and the Go module tag, if it exists), an
// empty destination, and a CHANGELOG.md entry for the version.
//
// The tag checks read the local repository's tags only; run
// `git fetch --tags` first. The release workflow checks out with
// fetch-depth: 0, which fetches every tag; a checkout without tags (such as
// ci.yml's) sees none, so its candidates pass the existing-tag check.

import {
  packageFiles,
  type ReleaseManifest,
  sha256,
  verifyRelease,
} from "./verify-release.ts";

export const repositorySlug = "nullstyle/capnpc-wasm";
export const repositoryUrl = `https://github.com/${repositorySlug}`;

export type FlavorName =
  | "capnpc-wasm"
  | "capnp-wasm-tools"
  | "capnp-wasm-compiler-host";

/** One archive flavor: what it ships and how it is named. */
export interface Flavor {
  /** Archive stem prefix, npm name suffix, release-tag prefix, notices name. */
  readonly name: FlavorName;
  /** The command-line flag that selects the flavor; the full SDK needs none. */
  readonly flag?: "--tools-only" | "--compiler-host";
  /** package.json description and the first line of the release notes. */
  readonly description: string;
  /** Ships typescript/ (mod.js, mod.d.ts, worker.js) and docs/typescript.md. */
  readonly typescript: boolean;
  /** Ships every Wasm command and the Zig historical reference, not only capnp.wasm. */
  readonly generators: boolean;
  /** Ships bin/capnp-wasm and runtime/wasmtime-version. */
  readonly launcher: boolean;
  /** Ships the Go SDK source and its dependency provenance. */
  readonly goSdk: boolean;
}

export const flavors: readonly Flavor[] = [
  {
    name: "capnpc-wasm",
    description:
      "Cap'n Proto compiler and generators for browser workers, Deno, and WASI hosts",
    typescript: true,
    generators: true,
    launcher: true,
    goSdk: true,
  },
  {
    name: "capnp-wasm-tools",
    flag: "--tools-only",
    description:
      "Cap'n Proto compiler and Wasmtime launcher for repository toolchains",
    typescript: false,
    generators: false,
    launcher: true,
    goSdk: false,
  },
  {
    name: "capnp-wasm-compiler-host",
    flag: "--compiler-host",
    description: "Cap'n Proto schema compiler for Deno and browser workers",
    typescript: true,
    generators: false,
    launcher: false,
    goSdk: false,
  },
];

export function flavorNamed(name: string): Flavor {
  const flavor = flavors.find((candidate) => candidate.name === name);
  if (!flavor) throw new Error(`unknown release flavor: ${name}`);
  return flavor;
}

export const packageName = (flavor: Flavor) => `@nullstyle/${flavor.name}`;
export const archiveStem = (flavor: Flavor, version: string) =>
  `${flavor.name}-${version}`;
/** The Git tag that publishes a flavor; the release workflow triggers on it. */
export const releaseTag = (flavor: Flavor, version: string) =>
  `${flavor.name}-v${version}`;
/**
 * The Go module's tag. The module ships in the full SDK archive, so it takes
 * the capnpc-wasm version and belongs at the commit of that release.
 */
export const goModuleTag = (version: string) => `sdk/go/v${version}`;

/**
 * Every tag a flavor's version names: its release tag and, for the flavor
 * that ships the Go SDK, the Go module tag.
 */
export function versionTags(flavor: Flavor, version: string): string[] {
  return [
    releaseTag(flavor, version),
    ...(flavor.goSdk ? [goModuleTag(version)] : []),
  ];
}

/** release.json: one version per flavor and the settings they share. */
export interface ReleaseFile {
  /** The full SDK's package name. */
  name: string;
  /** Each flavor's own version; releasing one flavor changes no other. */
  versions: Record<FlavorName, string>;
  private: true;
  license: "Apache-2.0";
}

/** One flavor's release metadata. */
export interface ReleaseMetadata {
  /** The flavor's package name, `@nullstyle/<flavor>`. */
  name: string;
  /** The flavor's own version, `versions["<flavor>"]` in release.json. */
  version: string;
  private: true;
  license: "Apache-2.0";
}

/**
 * The private release-candidate scheme, `X.Y.Z-rc.N` with no leading zeros
 * (Semantic Versioning); no other version is prepared yet.
 */
const candidateVersion =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-rc\.(?:0|[1-9]\d*)$/;

/**
 * Parses and validates release.json: the keys `name` (the full SDK's package
 * name), `versions`, `private` (true), and `license` (Apache-2.0) and no
 * others, and in `versions` exactly one `X.Y.Z-rc.N` version per flavor. A
 * missing or unknown flavor is an error.
 */
export function parseReleaseFile(
  text: string,
  path = "release.json",
): ReleaseFile {
  const problem = (message: string) => new Error(`${path}: ${message}`);
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const metadata: unknown = JSON.parse(text);
  if (!isObject(metadata)) throw problem("expected a JSON object");
  for (const key of Object.keys(metadata)) {
    if (key === "version") {
      throw problem(
        'unexpected key "version": each flavor has its own version under "versions"',
      );
    }
    if (!["name", "versions", "private", "license"].includes(key)) {
      throw problem(`unexpected key "${key}"`);
    }
  }
  const fullName = packageName(flavorNamed("capnpc-wasm"));
  if (metadata.name !== fullName) throw problem(`name must be ${fullName}`);
  if (metadata.private !== true) {
    throw problem(
      "private must be true; only private release candidates are prepared",
    );
  }
  if (metadata.license !== "Apache-2.0") {
    throw problem("license must be Apache-2.0");
  }
  const versions = metadata.versions;
  if (!isObject(versions)) {
    throw problem("versions must be an object with one version per flavor");
  }
  for (const key of Object.keys(versions)) {
    if (!flavors.some((flavor) => flavor.name === key)) {
      throw problem(`versions names an unknown flavor "${key}"`);
    }
  }
  for (const flavor of flavors) {
    if (!Object.hasOwn(versions, flavor.name)) {
      throw problem(`versions has no entry for ${flavor.name}`);
    }
    const version = versions[flavor.name];
    if (typeof version !== "string" || !candidateVersion.test(version)) {
      throw problem(
        `${flavor.name} version ${
          JSON.stringify(version)
        } is not a private release candidate (X.Y.Z-rc.N)`,
      );
    }
  }
  return metadata as unknown as ReleaseFile;
}

/** Reads release.json and returns one flavor's package name and version. */
export async function readMetadata(
  flavor: Flavor,
  path = "release.json",
): Promise<ReleaseMetadata> {
  const release = parseReleaseFile(await Deno.readTextFile(path), path);
  return {
    name: packageName(flavor),
    version: release.versions[flavor.name],
    private: release.private,
    license: release.license,
  };
}

export interface PrepareOptions {
  flavor: Flavor;
  /** Directory that receives <stem>/; relative to the repository root. */
  out?: string;
  allowDirty?: boolean;
  allowExistingTag?: boolean;
  publish?: boolean;
}

export interface PreparedRelease {
  flavor: Flavor;
  name: string;
  version: string;
  stem: string;
  tag: string;
  commit: string;
  dirty: boolean;
  directory: string;
  archive: string;
  manifestAsset: string;
  sbom: string;
  notes: string;
  sums: string;
  archiveSha256: string;
  manifestSha256: string;
  sbomSha256: string;
}

interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

async function run(args: string[]): Promise<CommandResult> {
  const output = await new Deno.Command(args[0], {
    args: args.slice(1),
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: output.success,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

async function command(args: string[]): Promise<string> {
  const result = await run(args);
  if (!result.success) {
    throw new Error(`${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout.trimEnd();
}

const short = (commit: string) => commit.slice(0, 7);

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function removeIfPresent(path: string) {
  await Deno.remove(path, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
}

function validateOut(out: string): string {
  const trimmed = out.replace(/\/+$/, "");
  if (
    trimmed === "" || trimmed.startsWith("/") ||
    trimmed.split("/").some((part) => part === "" || part === "..")
  ) {
    throw new Error(
      `--out must be a relative directory without ".." segments: ${out}`,
    );
  }
  return trimmed;
}

// Markdown --------------------------------------------------------------------

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

/**
 * Rewrites the relative links of a repository document for a package that
 * does not contain their targets: each one points at the same file in the
 * repository at the producer commit. Fenced code and inline code spans are
 * left alone, and a note is inserted after the title.
 */
export function packagedDocument(
  markdown: string,
  sourcePath: string,
  tree: string,
  note: string,
): string {
  const directory = sourcePath.includes("/")
    ? sourcePath.slice(0, sourcePath.lastIndexOf("/"))
    : "";
  const rewrite = (target: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) {
      return target;
    }
    const hash = target.indexOf("#");
    const path = hash === -1 ? target : target.slice(0, hash);
    const anchor = hash === -1 ? "" : target.slice(hash);
    return `${tree}/${normalizePath(`${directory}/${path}`)}${anchor}`;
  };
  const lines: string[] = [];
  let fenced = false;
  let noted = false;
  for (const raw of markdown.split("\n")) {
    const fence = /^\s*(```|~~~)/.test(raw);
    if (fence) fenced = !fenced;
    if (fenced || fence) {
      lines.push(raw);
      continue;
    }
    lines.push(
      raw.replace(
        /(`[^`]*`)|\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g,
        (whole, code, text, target, title) =>
          code !== undefined ? whole : `[${text}](${rewrite(target)}${title})`,
      ),
    );
    if (!noted && /^# /.test(raw)) {
      lines.push("", `> ${note}`);
      noted = true;
    }
  }
  if (!noted) lines.unshift(`> ${note}`, "");
  return lines.join("\n");
}

async function renderTemplate(
  path: string,
  values: Record<string, string>,
): Promise<string> {
  const template = await Deno.readTextFile(path);
  return template.replace(/\{\{([A-Za-z0-9]+)\}\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`${path}: unknown placeholder {{${key}}}`);
    }
    return value;
  });
}

/**
 * The text under `### <version>` in the flavor's `## <flavor>` section of
 * CHANGELOG.md, or undefined when the section or the entry is missing.
 */
export function changelogEntry(
  changelog: string,
  flavor: Flavor,
  version: string,
): string | undefined {
  let inFlavor = false;
  let inVersion = false;
  let found = false;
  const entry: string[] = [];
  for (const line of changelog.split("\n")) {
    if (/^## /.test(line)) {
      if (inVersion) break;
      inFlavor = line === `## ${flavor.name}` ||
        line.startsWith(`## ${flavor.name} `);
      continue;
    }
    if (/^### /.test(line)) {
      if (inVersion) break;
      inVersion = inFlavor &&
        (line === `### ${version}` || line.startsWith(`### ${version} `));
      if (inVersion) found = true;
      continue;
    }
    if (inVersion) entry.push(line);
  }
  return found ? entry.join("\n").trim() : undefined;
}

// Components and the SBOM -----------------------------------------------------

interface ComponentRecord {
  name: string;
  origin: string;
  /** An SPDX license expression; test:package refuses one that spdxExpressionProblem rejects. */
  license: string;
  /** Prose the expression cannot carry, such as portions' own licenses. */
  note?: string;
  files: string[];
}

interface ArtifactRecord {
  path: string;
  description: string;
  components: ComponentRecord[];
}

interface ComponentsFile {
  flavors: Record<string, string[]>;
  artifacts: ArtifactRecord[];
}

/** The components (deduplicated) and license files a flavor's artifacts use. */
function flavorComponents(
  components: ComponentsFile,
  flavor: Flavor,
): { components: ComponentRecord[]; files: string[] } {
  const artifacts = components.flavors[flavor.name];
  if (!artifacts) {
    throw new Error(
      `dist/licenses/components.json has no flavor ${flavor.name}; rerun build:sdk`,
    );
  }
  const seen = new Map<string, ComponentRecord>();
  const files = new Set<string>();
  for (const artifact of components.artifacts) {
    if (!artifacts.includes(artifact.path)) continue;
    for (const component of artifact.components) {
      seen.set(`${component.name}\0${component.origin}`, component);
      for (const file of component.files) files.add(file);
    }
  }
  return {
    components: [...seen.values()].sort((a, b) =>
      a.name.localeCompare(b.name) || a.origin.localeCompare(b.origin)
    ),
    files: [...files].sort(),
  };
}

/**
 * The SPDX license identifiers (https://spdx.org/licenses/) that the
 * components' license expressions may use. Check a new identifier against
 * that list, and its text against the component's license files, before
 * adding it.
 */
export const spdxLicenseIds: readonly string[] = [
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "MIT",
];
/**
 * The SPDX license exception identifiers
 * (https://spdx.org/licenses/exceptions-index.html) the expressions may use.
 */
export const spdxExceptionIds: readonly string[] = ["LLVM-exception"];

const spdxOperators = new Set(["AND", "OR", "WITH"]);
const spdxLookup = (ids: readonly string[]) =>
  new Map(ids.map((id) => [id.toLowerCase(), id]));

/**
 * Why `expression` is not an SPDX 2.3 license expression (Annex D) built from
 * spdxLicenseIds and spdxExceptionIds, or undefined when it is one.
 * Identifiers match without regard to case and operators (AND, OR, WITH) in
 * upper case only, as SPDX specifies; `+` may follow a license identifier.
 * LicenseRef- and DocumentRef- identifiers are rejected, because the SBOM
 * carries no extracted license texts, and so are NOASSERTION and NONE, which
 * say that no expression is known.
 */
export function spdxExpressionProblem(expression: string): string | undefined {
  const licenses = spdxLookup(spdxLicenseIds);
  const exceptions = spdxLookup(spdxExceptionIds);
  // Only ASCII white space separates tokens; any other character, such as a
  // non-breaking space, stays inside a token and fails as an identifier.
  const tokens = expression.match(/\(|\)|[^ \t\r\n()]+/g) ?? [];
  let index = 0;
  // Whether the last term is a bare license identifier, which WITH may follow.
  let afterLicense = false;
  const unknown = (kind: string, id: string, list: string, constant: string) =>
    /^[A-Za-z0-9.-]+$/.test(id)
      ? `${id} is not an allow-listed SPDX ${kind} identifier; check ${list} and the component's license files, then add it to ${constant} in scripts/release.ts`
      : `${
        JSON.stringify(id)
      } is not an SPDX ${kind} identifier, which holds only letters, digits, "-", and "."${
        /[^\x21-\x7e]/.test(id)
          ? " (this one holds a character outside printable ASCII, such as a non-breaking space)"
          : ""
      }`;
  const unexpected = (closing: boolean): string => {
    const token = tokens[index];
    if (token === "WITH") {
      return "WITH follows a single license identifier only, not a parenthesized expression or an exception";
    }
    if (token === ")") return 'a ")" has no matching "("';
    const expected = [
      "AND",
      "OR",
      ...(afterLicense ? ["WITH"] : []),
      closing ? '")"' : "the end",
    ];
    return `${JSON.stringify(token)} stands where ${
      expected.slice(0, -1).join(", ")
    }, or ${expected.at(-1)} was expected${
      spdxOperators.has(token.toUpperCase())
        ? " (operators are upper case)"
        : ""
    }`;
  };
  const term = (): string | undefined => {
    afterLicense = false;
    const token = tokens[index];
    if (token === undefined) {
      return tokens.length === 0
        ? "the expression is empty"
        : "the expression ends where a license was expected";
    }
    if (token === "(") {
      index += 1;
      const problem = compound();
      if (problem !== undefined) return problem;
      if (tokens[index] === undefined) return 'a "(" has no matching ")"';
      if (tokens[index] !== ")") return unexpected(true);
      index += 1;
      afterLicense = false;
      return undefined;
    }
    if (token === ")") return '")" stands where a license was expected';
    if (spdxOperators.has(token)) {
      return `the operator ${token} stands where a license was expected`;
    }
    index += 1;
    const special = token.toUpperCase();
    if (special === "NOASSERTION" || special === "NONE") {
      return `${token} records that no license expression is known`;
    }
    if (/^(?:DocumentRef-|LicenseRef-)/i.test(token)) {
      return `${token}: LicenseRef identifiers are not accepted, because the SBOM carries no extracted license texts`;
    }
    const license = token.endsWith("+") ? token.slice(0, -1) : token;
    if (!licenses.has(license.toLowerCase())) {
      return exceptions.has(license.toLowerCase())
        ? `the exception ${license} stands where a license was expected`
        : unknown(
          "license",
          license === "" ? token : license,
          "https://spdx.org/licenses/",
          "spdxLicenseIds",
        );
    }
    if (tokens[index] !== "WITH") {
      afterLicense = true;
      return undefined;
    }
    index += 1;
    const exception = tokens[index];
    if (
      exception === undefined || exception === "(" || exception === ")" ||
      spdxOperators.has(exception)
    ) return "WITH is not followed by an exception identifier";
    index += 1;
    if (!exceptions.has(exception.toLowerCase())) {
      return licenses.has(exception.toLowerCase())
        ? `the license ${exception} stands where an exception was expected`
        : unknown(
          "exception",
          exception,
          "https://spdx.org/licenses/exceptions-index.html",
          "spdxExceptionIds",
        );
    }
    return undefined;
  };
  const compound = (): string | undefined => {
    const problem = term();
    if (problem !== undefined) return problem;
    while (tokens[index] === "AND" || tokens[index] === "OR") {
      index += 1;
      const next = term();
      if (next !== undefined) return next;
    }
    return undefined;
  };
  const problem = compound();
  if (problem !== undefined) return problem;
  return index < tokens.length ? unexpected(false) : undefined;
}

/** True for an SPDX license expression that spdxExpressionProblem accepts. */
export function isSpdxExpression(expression: string): boolean {
  return spdxExpressionProblem(expression) === undefined;
}

/** The [tools] pins in mise.toml, in file order. */
export function toolPins(
  miseToml: string,
): { name: string; version: string }[] {
  const pins: { name: string; version: string }[] = [];
  let section = "";
  for (const raw of miseToml.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table) {
      section = table[1];
      continue;
    }
    if (section === "tools") {
      const pin =
        /^"?([^"=\s]+)"?\s*=\s*(?:"([^"]+)"|\{.*\bversion\s*=\s*"([^"]+)".*\})$/
          .exec(line);
      if (pin) pins.push({ name: pin[1], version: pin[2] ?? pin[3] });
    } else if (/^tools\.[^.\]]+$/.test(section)) {
      const pin = /^version\s*=\s*"([^"]+)"$/.exec(line);
      if (pin) {
        pins.push({ name: section.slice("tools.".length), version: pin[1] });
      }
    }
  }
  return pins;
}

interface SpdxPackage {
  name: string;
  SPDXID: string;
  versionInfo?: string;
  downloadLocation: string;
  filesAnalyzed: boolean;
  checksums?: { algorithm: "SHA256"; checksumValue: string }[];
  licenseConcluded: string;
  licenseDeclared: string;
  licenseComments?: string;
  copyrightText: string;
  primaryPackagePurpose?: string;
  sourceInfo?: string;
  comment?: string;
  externalRefs?: {
    referenceCategory: string;
    referenceType: string;
    referenceLocator: string;
  }[];
}

export interface SbomInput {
  flavor: Flavor;
  name: string;
  version: string;
  stem: string;
  tag: string;
  commit: string;
  /** SPDX timestamp (UTC, no fractional seconds). */
  created: string;
  publish: boolean;
  manifest: ReleaseManifest;
  archiveSha256: string;
  components: ComponentRecord[];
  /** Gitlink path to .gitmodules URL. */
  submodules: Record<string, string>;
  /** third_party/wasi-sdk-34/manifest.json sources. */
  vendored: Record<string, { repository: string; commit: string }>;
  tools: { name: string; version: string }[];
}

function spdxId(kind: string, text: string, used: Set<string>): string {
  const base = `SPDXRef-${kind}-${text.replace(/[^A-Za-z0-9.-]+/g, "-")}`;
  let id = base;
  for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
  used.add(id);
  return id;
}

function purlRef(locator: string) {
  return {
    referenceCategory: "PACKAGE-MANAGER",
    referenceType: "purl",
    referenceLocator: locator,
  };
}

function componentIdentity(
  component: ComponentRecord,
  input: SbomInput,
): { versionInfo: string; downloadLocation: string; purl?: string } {
  const origin = component.origin;
  let match: RegExpExecArray | null;
  if (origin === "this repository") {
    // The project's own code at the producer commit. The flavor's version
    // belongs to the archive (the root package): the tools archive at
    // 0.1.0-rc.3 does not contain a capnpc-wasm 0.1.0-rc.3.
    return {
      versionInfo: input.commit,
      downloadLocation: `git+${repositoryUrl}.git@${input.commit}`,
      purl: `pkg:github/${repositorySlug}@${input.commit}`,
    };
  }
  if ((match = /^ref\/(\S+) at [0-9a-f]+$/.exec(origin))) {
    const path = `ref/${match[1]}`;
    const commit = input.manifest.references[path];
    const url = input.submodules[path];
    if (!commit || !url) {
      throw new Error(`no gitlink or .gitmodules URL for component ${path}`);
    }
    const github = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(
      url,
    );
    return {
      versionInfo: commit,
      downloadLocation: `git+${url}@${commit}`,
      ...(github ? { purl: `pkg:github/${github[1]}@${commit}` } : {}),
    };
  }
  if ((match = /^Go module (\S+)@(\S+)$/.exec(origin))) {
    return {
      versionInfo: match[2],
      downloadLocation: "NOASSERTION",
      purl: `pkg:golang/${match[1]}@${match[2]}`,
    };
  }
  if ((match = /^crate (\S+) (\S+) \((\S+)\)$/.exec(origin))) {
    const registry = match[3].startsWith(
      "registry+https://github.com/rust-lang/crates.io-index",
    );
    return {
      versionInfo: match[2],
      downloadLocation: registry
        ? `https://crates.io/api/v1/crates/${match[1]}/${match[2]}/download`
        : "NOASSERTION",
      purl: `pkg:cargo/${match[1]}@${match[2]}`,
    };
  }
  if (
    (match = /^(WebAssembly\/wasi-libc|llvm\/llvm-project) at /.exec(origin))
  ) {
    const vendored = input.vendored[match[1].slice(match[1].indexOf("/") + 1)];
    if (!vendored) throw new Error(`no vendored record for ${match[1]}`);
    return {
      versionInfo: vendored.commit,
      downloadLocation: `git+${vendored.repository}@${vendored.commit}`,
      purl: `pkg:github/${match[1]}@${vendored.commit}`,
    };
  }
  if ((match = /^go(\d\S*)$/.exec(origin))) {
    return { versionInfo: match[1], downloadLocation: "NOASSERTION" };
  }
  if ((match = /^(?:rustc|Zig) (\S+)/.exec(origin))) {
    return { versionInfo: match[1], downloadLocation: "NOASSERTION" };
  }
  return { versionInfo: origin, downloadLocation: "NOASSERTION" };
}

/** SPDX 2.3 JSON for one archive, built from the manifest and components.json. */
export function spdxDocument(input: SbomInput): string {
  const used = new Set<string>(["SPDXRef-DOCUMENT"]);
  const rootId = spdxId("Package", input.stem, used);
  const rootPurl = input.flavor.typescript
    ? `pkg:npm/%40nullstyle/${input.flavor.name}@${input.version}`
    : `pkg:github/${repositorySlug}@${input.commit}`;
  const root: SpdxPackage = {
    name: input.name,
    SPDXID: rootId,
    versionInfo: input.version,
    downloadLocation: input.publish
      ? `${repositoryUrl}/releases/download/${input.tag}/${input.stem}.tgz`
      : "NOASSERTION",
    filesAnalyzed: false,
    checksums: [{ algorithm: "SHA256", checksumValue: input.archiveSha256 }],
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "Apache-2.0",
    licenseComments:
      "Apache-2.0 covers the project's own code; every other component is listed with its own license, and THIRD_PARTY_NOTICES.md in the archive names the license texts.",
    copyrightText: "NOASSERTION",
    primaryPackagePurpose: input.flavor.typescript ? "LIBRARY" : "APPLICATION",
    sourceInfo:
      `Built from ${repositoryUrl} at commit ${input.commit} (source tree digest ${input.manifest.source.sha256}) by scripts/release.ts; provenance/ in the archive holds the source-file digests and tool pins.`,
    externalRefs: [
      purlRef(rootPurl),
      {
        referenceCategory: "OTHER",
        referenceType: "vcs",
        referenceLocator: `git+${repositoryUrl}.git@${input.commit}`,
      },
    ],
  };
  const packages: SpdxPackage[] = [root];
  const relationships = [{
    spdxElementId: "SPDXRef-DOCUMENT",
    relationshipType: "DESCRIBES",
    relatedSpdxElement: rootId,
  }];
  for (const component of input.components) {
    const identity = componentIdentity(component, input);
    // A license that fails the gate (test:package rejects it) is never
    // declared; its text stays readable as a comment.
    const valid = isSpdxExpression(component.license);
    const comments = [
      ...(valid || component.license === "NOASSERTION"
        ? []
        : [component.license]),
      ...(component.note ? [component.note] : []),
    ].join(" ");
    const pkg: SpdxPackage = {
      name: component.name,
      SPDXID: spdxId("Component", component.name, used),
      versionInfo: identity.versionInfo,
      downloadLocation: identity.downloadLocation,
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: valid ? component.license : "NOASSERTION",
      ...(comments ? { licenseComments: comments } : {}),
      copyrightText: "NOASSERTION",
      comment: `Origin: ${component.origin}. License texts in the archive: ${
        component.files.map((file) => `licenses/${file}`).join(", ")
      }.`,
      ...(identity.purl ? { externalRefs: [purlRef(identity.purl)] } : {}),
    };
    packages.push(pkg);
    relationships.push({
      spdxElementId: rootId,
      relationshipType: "CONTAINS",
      relatedSpdxElement: pkg.SPDXID,
    });
  }
  const toolRelationship: Record<string, string> = {
    "deno-worker": "TEST_TOOL_OF",
    shellcheck: "DEV_TOOL_OF",
  };
  for (const tool of input.tools) {
    const pkg: SpdxPackage = {
      name: tool.name,
      SPDXID: spdxId("Tool", tool.name, used),
      versionInfo: tool.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "NOASSERTION",
      copyrightText: "NOASSERTION",
      comment:
        "Pinned in provenance/mise.toml; provenance/mise.lock records the resolved downloads and their digests.",
    };
    packages.push(pkg);
    relationships.push({
      spdxElementId: pkg.SPDXID,
      relationshipType: toolRelationship[tool.name] ?? "BUILD_TOOL_OF",
      relatedSpdxElement: rootId,
    });
  }
  return JSON.stringify(
    {
      spdxVersion: "SPDX-2.3",
      dataLicense: "CC0-1.0",
      SPDXID: "SPDXRef-DOCUMENT",
      name: input.stem,
      // A candidate and the publishable document differ (download location),
      // so they cannot share one namespace.
      documentNamespace: `${repositoryUrl}/spdx/${input.stem}/${input.commit}${
        input.publish ? "" : "/candidate"
      }`,
      creationInfo: {
        created: input.created,
        creators: ["Tool: capnpc-wasm-release.ts"],
        comment:
          "Generated by scripts/release.ts from the archive manifest, dist/licenses/components.json, and the tool pins in mise.toml. The creation time is the producer commit's committer date, so the document is reproducible for the same source and built inputs.",
      },
      packages,
      relationships,
    },
    null,
    2,
  ) + "\n";
}

// Preparation -----------------------------------------------------------------

export interface RefusalInput {
  flavor: Flavor;
  /** The flavor's own version from release.json. */
  version: string;
  /** HEAD. */
  commit: string;
  /** Whether `git status --porcelain` lists anything. */
  dirty: boolean;
  /** The commit each of versionTags(flavor, version) names, if it exists. */
  tags: Readonly<Record<string, string | undefined>>;
  publish: boolean;
  allowDirty: boolean;
  allowExistingTag: boolean;
}

/**
 * Why a build of one flavor's version from `commit` must not proceed, or
 * undefined. An archive is tied to one clean commit, and a version names one
 * set of bytes: candidate mode refuses a dirty tree and a version whose tags
 * exist at another commit, and publish mode requires the release tag at HEAD.
 * Each flavor answers only for its own version and tags; the full SDK's also
 * cover the Go module tag, which may be created later but only at the same
 * commit.
 */
export function refusal(input: RefusalInput): string | undefined {
  const { flavor, version, commit, tags } = input;
  const [tag, ...related] = versionTags(flavor, version);
  const subject = (name: string) =>
    name === tag
      ? `version ${version} of ${packageName(flavor)}`
      : `version ${version} of the Go module`;
  if (input.publish) {
    if (input.allowDirty || input.allowExistingTag) {
      return `--allow-dirty and --allow-existing-tag are not accepted with --publish (${flavor.name} ${version})`;
    }
    if (input.dirty) {
      return `refusing to publish ${flavor.name} ${version} from a working tree with uncommitted or untracked changes (git status --porcelain is not empty)`;
    }
    const tagCommit = tags[tag];
    if (tagCommit === undefined) {
      return `refusing to publish: HEAD ${
        short(commit)
      } is not tagged ${tag}; publishable archives are built from the tagged commit`;
    }
    if (tagCommit !== commit) {
      return `refusing to publish: tag ${tag} points at ${
        short(tagCommit)
      }, not at HEAD ${short(commit)}`;
    }
    for (const name of related) {
      const tagged = tags[name];
      if (tagged !== undefined && tagged !== commit) {
        return `refusing to publish: tag ${name} points at ${
          short(tagged)
        }, not at HEAD ${
          short(commit)
        }; ${tag} and ${name} must name the same source`;
      }
    }
    return undefined;
  }
  if (input.dirty && !input.allowDirty) {
    return `the working tree has uncommitted or untracked changes; commit them, or pass --allow-dirty for a local ${flavor.name} ${version} candidate (candidates are never published)`;
  }
  if (!input.allowExistingTag) {
    for (const name of [tag, ...related]) {
      const tagged = tags[name];
      if (tagged !== undefined && tagged !== commit) {
        return `${name} already exists at ${short(tagged)}: ${
          subject(name)
        } was tagged from another commit, so a candidate built here could never be published under it. Choose the next ${flavor.name} version in release.json (versions["${flavor.name}"]; docs/releases.md describes the procedure), or pass --allow-existing-tag for a throwaway candidate`;
      }
    }
  }
  return undefined;
}

export async function prepareRelease(
  options: PrepareOptions,
): Promise<PreparedRelease> {
  const { flavor } = options;
  const publish = options.publish === true;
  const metadata = await readMetadata(flavor);
  const { name, version } = metadata;
  const stem = archiveStem(flavor, version);
  const tag = releaseTag(flavor, version);

  const commit = await command(["git", "rev-parse", "HEAD"]);
  const dirty = (await command(["git", "status", "--porcelain"])) !== "";
  const tags: Record<string, string | undefined> = {};
  for (const tagName of versionTags(flavor, version)) {
    const tagged = await run([
      "git",
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/tags/${tagName}^{commit}`,
    ]);
    tags[tagName] = tagged.success ? tagged.stdout.trim() : undefined;
  }
  const refused = refusal({
    flavor,
    version,
    commit,
    dirty,
    tags,
    publish,
    allowDirty: options.allowDirty === true,
    allowExistingTag: options.allowExistingTag === true,
  });
  if (refused !== undefined) throw new Error(refused);
  const changelog = changelogEntry(
    await Deno.readTextFile("CHANGELOG.md"),
    flavor,
    version,
  );
  if (publish && changelog === undefined) {
    throw new Error(
      `CHANGELOG.md has no "### ${version}" entry under "## ${flavor.name}"; add one before tagging`,
    );
  }

  const out = validateOut(options.out ?? "dist/releases");
  const destination = `${out}/${stem}`;
  const staging = `${out}/.${stem}.staging`;
  if (publish && await exists(destination)) {
    throw new Error(`refusing to publish over the existing ${destination}`);
  }
  await Deno.mkdir(out, { recursive: true });
  await removeIfPresent(staging);
  const pkg = `${staging}/package`;
  await Deno.mkdir(pkg, { recursive: true });

  const parent = (target: string) =>
    `${pkg}/${
      target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : ""
    }`;
  async function copy(source: string, target: string) {
    await Deno.mkdir(parent(target), { recursive: true });
    await Deno.copyFile(source, `${pkg}/${target}`);
  }
  async function copyTree(source: string, target: string) {
    for (const path of await packageFiles(source)) {
      await copy(`${source}/${path}`, `${target}/${path}`);
    }
  }
  async function write(target: string, text: string) {
    await Deno.mkdir(parent(target), { recursive: true });
    await Deno.writeTextFile(`${pkg}/${target}`, text);
  }

  try {
    const tree = `${repositoryUrl}/blob/${commit}`;
    const miseToml = await Deno.readTextFile("mise.toml");
    const wasmtimeVersion = /^wasmtime = "([0-9]+\.[0-9]+\.[0-9]+)"$/m.exec(
      miseToml,
    )?.[1];
    if (!wasmtimeVersion) {
      throw new Error("missing exact Wasmtime pin in mise.toml");
    }
    const denoWorkerVersion =
      /^export const supportedDenoWorkerVersion = "([0-9][0-9.]*)";$/m.exec(
        await Deno.readTextFile("sdk/typescript/environment.ts"),
      )?.[1];
    if (!denoWorkerVersion) {
      throw new Error(
        "missing supportedDenoWorkerVersion in sdk/typescript/environment.ts",
      );
    }

    // Built assets.
    if (flavor.typescript) await copyTree("dist/typescript", "typescript");
    if (flavor.generators) await copyTree("dist/wasm", "wasm");
    else await copy("dist/wasm/capnp.wasm", "wasm/capnp.wasm");
    await copyTree("dist/include", "include");

    // Notices: only this flavor's license texts, and its own notices file at
    // the package root.
    const componentsFile = JSON.parse(
      await Deno.readTextFile("dist/licenses/components.json"),
    ) as ComponentsFile;
    const { components, files: licenseFiles } = flavorComponents(
      componentsFile,
      flavor,
    );
    for (const file of licenseFiles) {
      await copy(`dist/licenses/${file}`, `licenses/${file}`);
    }
    await copy(
      `dist/licenses/THIRD_PARTY_NOTICES-${flavor.name}.md`,
      "THIRD_PARTY_NOTICES.md",
    );

    if (flavor.launcher) {
      await copy("bin/capnp-wasm", "bin/capnp-wasm");
      await write("runtime/wasmtime-version", `${wasmtimeVersion}\n`);
    }
    if (flavor.goSdk) {
      // Every non-test Go source file, so a new file is never dropped.
      const goFiles: string[] = [];
      for await (const entry of Deno.readDir("sdk/go")) {
        if (
          entry.isFile && entry.name.endsWith(".go") &&
          !entry.name.endsWith("_test.go")
        ) goFiles.push(entry.name);
      }
      if (goFiles.length === 0) throw new Error("sdk/go has no Go sources");
      for (const file of [...goFiles.sort(), "go.mod", "go.sum", "LICENSE"]) {
        await copy(`sdk/go/${file}`, `sdk/go/${file}`);
      }
      await write(
        "sdk/go/README.md",
        packagedDocument(
          await Deno.readTextFile("sdk/go/README.md"),
          "sdk/go/README.md",
          tree,
          `This is the Go SDK guide from the repository at commit \`${
            short(commit)
          }\`; its relative links point at the repository at that commit. The module source is this directory; in the package, the Wasm modules are under \`../../wasm/\` and the standard schemas under \`../../include/\`.`,
        ),
      );
    }
    await copy("scripts/verify-release.ts", "verify-release.ts");
    await copy("mise.toml", "provenance/mise.toml");
    await copy("mise.lock", "provenance/mise.lock");
    if (flavor.generators) {
      await copy(
        "generators/zig/historical-reference",
        "provenance/zig-historical-reference",
      );
    }

    // Documents: a usage README generated per flavor, and the SDK guide with
    // its links pointed at the repository at this commit.
    await write(
      "README.md",
      await renderTemplate(`scripts/templates/README-${flavor.name}.md`, {
        name,
        version,
        stem,
        tag,
        commit,
        shortCommit: short(commit),
        repository: repositoryUrl,
        tree,
        wasmtime: wasmtimeVersion,
        denoWorker: denoWorkerVersion,
      }),
    );
    if (flavor.typescript) {
      await write(
        "docs/typescript.md",
        packagedDocument(
          await Deno.readTextFile("sdk/typescript/README.md"),
          "sdk/typescript/README.md",
          tree,
          `This is the TypeScript SDK guide from the repository at commit \`${
            short(commit)
          }\`; its relative links point at the repository at that commit. It describes the source checkout: \`dist/typescript/\`, \`dist/wasm/\`, and \`dist/include/\` there are \`typescript/\`, \`wasm/\`, and \`include/\` in this package, whose README.md shows the package-relative example.`,
        ),
      );
    }
    await copy("LICENSE", "LICENSE");
    await write(
      "package.json",
      JSON.stringify(
        {
          name,
          version,
          private: metadata.private,
          license: metadata.license,
          type: "module",
          description: flavor.description,
          ...(flavor.typescript
            ? { main: "./typescript/mod.js", types: "./typescript/mod.d.ts" }
            : {}),
          ...(flavor.launcher
            ? { bin: { "capnp-wasm": "./bin/capnp-wasm" } }
            : {}),
          exports: {
            ...(flavor.typescript
              ? {
                ".": {
                  types: "./typescript/mod.d.ts",
                  import: "./typescript/mod.js",
                },
                "./worker": "./typescript/worker.js",
              }
              : {}),
            "./wasm/*": "./wasm/*",
            "./include/*": "./include/*",
            "./manifest.json": "./manifest.json",
          },
          files: [
            ...(flavor.launcher ? ["bin", "runtime"] : []),
            ...(flavor.typescript ? ["typescript"] : []),
            ...(flavor.goSdk ? ["sdk/go"] : []),
            "wasm",
            "include",
            "licenses",
            "provenance",
            ...(flavor.typescript ? ["docs"] : []),
            "manifest.json",
            "verify-release.ts",
            "LICENSE",
            "THIRD_PARTY_NOTICES.md",
            "README.md",
          ],
          repository: { type: "git", url: `git+${repositoryUrl}.git` },
        },
        null,
        2,
      ) + "\n",
    );

    // Source provenance.
    const sources: { path: string; sha256: string }[] = [];
    for (
      const path of (await command([
        "git",
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ])).split("\0").filter(Boolean).sort()
    ) {
      if (path.startsWith("ref/")) continue;
      const stat = await Deno.lstat(path).catch((error) => {
        if (error instanceof Deno.errors.NotFound) return undefined;
        throw error;
      });
      if (!stat) continue;
      if (!stat.isFile) throw new Error(`unsupported source entry: ${path}`);
      sources.push({ path, sha256: await sha256(await Deno.readFile(path)) });
    }
    const sourceHash = await sha256(
      new TextEncoder().encode(
        sources.map((file) => `${file.sha256}  ${file.path}\n`).join(""),
      ),
    );
    await write(
      "provenance/sources.json",
      JSON.stringify(sources, null, 2) + "\n",
    );
    const references: Record<string, string> = {};
    const submodules: Record<string, string> = {};
    for (
      const line of (await command(["git", "ls-files", "--stage", "ref"]))
        .split("\n")
    ) {
      const match = /^160000 ([0-9a-f]{40}) 0\t(.+)$/.exec(line);
      if (!match) continue;
      const actual = await command([
        "git",
        "-C",
        match[2],
        "rev-parse",
        "HEAD",
      ]);
      if (actual !== match[1]) {
        throw new Error(
          `reference checkout differs from pinned gitlink: ${match[2]}`,
        );
      }
      references[match[2]] = actual;
      submodules[match[2]] = await command([
        "git",
        "config",
        "-f",
        ".gitmodules",
        "--get",
        `submodule.${match[2]}.url`,
      ]);
    }
    if (flavor.goSdk) {
      const goDependency = JSON.parse(
        await command([
          "go",
          "-C",
          "sdk/go",
          "mod",
          "download",
          "-json",
          "github.com/tetratelabs/wazero",
        ]),
      );
      const goRevision = JSON.parse(
        await command([
          "go",
          "-C",
          "sdk/go",
          "list",
          "-m",
          "-json",
          `github.com/tetratelabs/wazero@${references["ref/wazero"]}`,
        ]),
      );
      if (
        goRevision.Origin?.Hash !== references["ref/wazero"] ||
        goRevision.Version !== goDependency.Version
      ) {
        throw new Error(
          "SDK wazero pseudo-version does not match reference gitlink",
        );
      }
      await write(
        "provenance/go-dependency.json",
        JSON.stringify(
          {
            path: goDependency.Path,
            version: goDependency.Version,
            sum: goDependency.Sum,
            goModSum: goDependency.GoModSum,
            revision: goRevision.Origin.Hash,
          },
          null,
          2,
        ) + "\n",
      );
    }

    // Manifest and verification of the staged tree.
    const manifest: ReleaseManifest = {
      format: 1,
      name,
      version,
      source: { commit, dirty, sha256: sourceHash },
      references,
      files: [],
    };
    for (const path of await packageFiles(pkg)) {
      const bytes = await Deno.readFile(`${pkg}/${path}`);
      manifest.files.push({
        path,
        bytes: bytes.length,
        sha256: await sha256(bytes),
      });
    }
    const manifestBytes = new TextEncoder().encode(
      JSON.stringify(manifest, null, 2) + "\n",
    );
    await Deno.writeFile(`${pkg}/manifest.json`, manifestBytes);
    await verifyRelease(pkg);

    // Minimal deterministic POSIX ustar: sorted files, normalized metadata, no
    // symlinks, timestamps, host names, or platform-dependent tar extensions.
    const chunks: Uint8Array[] = [];
    for (const path of await packageFiles(pkg)) {
      const bytes = await Deno.readFile(`${pkg}/${path}`);
      const header = new Uint8Array(512);
      const entryName = new TextEncoder().encode(`package/${path}`);
      if (entryName.length > 100) {
        throw new Error(`archive path too long: ${path}`);
      }
      header.set(entryName);
      const field = (offset: number, width: number, value: number) =>
        header.set(
          new TextEncoder().encode(
            value.toString(8).padStart(width - 1, "0") + "\0",
          ),
          offset,
        );
      field(100, 8, path.startsWith("bin/") ? 0o755 : 0o644);
      field(108, 8, 0);
      field(116, 8, 0);
      field(124, 12, bytes.length);
      field(136, 12, 0);
      header.fill(32, 148, 156);
      header[156] = 48;
      header.set(new TextEncoder().encode("ustar\0" + "00"), 257);
      field(148, 7, header.reduce((sum, byte) => sum + byte, 0));
      header[155] = 32;
      chunks.push(
        header,
        bytes,
        new Uint8Array((512 - bytes.length % 512) % 512),
      );
    }
    chunks.push(new Uint8Array(1024));
    const archive = new Uint8Array(
      await new Response(
        new Blob(chunks.map((chunk) => new Uint8Array(chunk))).stream()
          .pipeThrough(new CompressionStream("gzip")),
      ).arrayBuffer(),
    );
    await Deno.writeFile(`${staging}/${stem}.tgz`, archive);
    const archiveSha256 = await sha256(archive);

    // The manifest as its own asset, so `sha256sum -c SHA256SUMS` passes on a
    // fresh download; the SBOM; the release notes; SHA256SUMS over the three
    // downloadable assets.
    await Deno.writeFile(`${staging}/${stem}.manifest.json`, manifestBytes);
    const manifestSha256 = await sha256(manifestBytes);
    const vendoredManifest = JSON.parse(
      await Deno.readTextFile("third_party/wasi-sdk-34/manifest.json"),
    ) as {
      sources: Record<string, { repository: string; commit: string }>;
    };
    const committed = await command([
      "git",
      "show",
      "-s",
      "--format=%ct",
      "HEAD",
    ]);
    const sbom = new TextEncoder().encode(spdxDocument({
      flavor,
      name,
      version,
      stem,
      tag,
      commit,
      created: new Date(Number(committed) * 1000).toISOString().replace(
        /\.\d{3}Z$/,
        "Z",
      ),
      publish,
      manifest,
      archiveSha256,
      components,
      submodules,
      vendored: vendoredManifest.sources,
      tools: toolPins(miseToml),
    }));
    await Deno.writeFile(`${staging}/${stem}.spdx.json`, sbom);
    const sbomSha256 = await sha256(sbom);
    await Deno.writeTextFile(
      `${staging}/${stem}.notes.md`,
      await renderTemplate("scripts/templates/release-notes.md", {
        description: flavor.description,
        repository: repositoryUrl,
        commit,
        shortCommit: short(commit),
        tag,
        stem,
        changes: changelog ??
          `No CHANGELOG.md entry for ${flavor.name} ${version} (candidate build).`,
        archiveSha256,
        manifestSha256,
        sbomSha256,
      }),
    );
    await Deno.writeTextFile(
      `${staging}/SHA256SUMS`,
      `${archiveSha256}  ${stem}.tgz\n${manifestSha256}  ${stem}.manifest.json\n${sbomSha256}  ${stem}.spdx.json\n`,
    );
    if (publish) {
      if (await exists(destination)) {
        throw new Error(`refusing to publish over the existing ${destination}`);
      }
    } else {
      await removeIfPresent(destination);
    }
    await Deno.rename(staging, destination);
    return {
      flavor,
      name,
      version,
      stem,
      tag,
      commit,
      dirty,
      directory: destination,
      archive: `${destination}/${stem}.tgz`,
      manifestAsset: `${destination}/${stem}.manifest.json`,
      sbom: `${destination}/${stem}.spdx.json`,
      notes: `${destination}/${stem}.notes.md`,
      sums: `${destination}/SHA256SUMS`,
      archiveSha256,
      manifestSha256,
      sbomSha256,
    };
  } catch (error) {
    await removeIfPresent(staging).catch(() => {});
    throw error;
  }
}

// Command line ----------------------------------------------------------------

export function parseArguments(args: string[]): PrepareOptions {
  const usage =
    "usage: release.ts [--tools-only | --compiler-host] [--out DIR] [--allow-dirty] [--allow-existing-tag] [--publish]";
  let flavor: Flavor | undefined;
  const options: PrepareOptions = { flavor: flavors[0] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const selected = flavors.find((candidate) => candidate.flag === arg);
    if (selected) {
      if (flavor) throw new Error(usage);
      flavor = selected;
    } else if (arg === "--out" || arg.startsWith("--out=")) {
      const value = arg === "--out"
        ? args[++index]
        : arg.slice("--out=".length);
      if (value === undefined || options.out !== undefined) {
        throw new Error(usage);
      }
      options.out = value;
    } else if (arg === "--allow-dirty") options.allowDirty = true;
    else if (arg === "--allow-existing-tag") options.allowExistingTag = true;
    else if (arg === "--publish") options.publish = true;
    else throw new Error(usage);
  }
  return { ...options, flavor: flavor ?? flavors[0] };
}

if (import.meta.main) {
  const options = parseArguments(Deno.args);
  const prepared = await prepareRelease(options);
  console.log(
    `Prepared ${
      options.publish ? "publishable" : "candidate"
    } ${prepared.name}@${prepared.version} from ${short(prepared.commit)}${
      prepared.dirty ? " (dirty working tree)" : ""
    }: ${prepared.archive}`,
  );
}
