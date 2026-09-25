// Verifies the full SDK and tools-only archives: candidates are prepared into
// build/test/package (never dist/releases), checked for reproducibility and
// asset integrity, extracted into a fresh directory under build/test, and
// exercised by external Deno and Go consumers, the launcher checks, the
// packaged README examples, and a link check over the packaged documents.
import { sha256, verifyRelease } from "./verify-release.ts";
import { archiveStem, flavorNamed, readMetadata } from "./release.ts";
import { checkLauncher } from "../tests/package/launcher.ts";

const repository = Deno.cwd();
const metadata = await readMetadata();
const out = "build/test/package";
const full = flavorNamed("capnpc-wasm");
const tools = flavorNamed("capnp-wasm-tools");
const stem = archiveStem(full, metadata.version);
const directory = `${repository}/${out}/${stem}`;
const archive = `${directory}/${stem}.tgz`;
const toolsStem = archiveStem(tools, metadata.version);
const toolsDirectory = `${repository}/${out}/${toolsStem}`;
const toolsArchive = `${toolsDirectory}/${toolsStem}.tgz`;

interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  expectFailure?: string;
}

async function command(
  args: string[],
  options: CommandOptions = {},
): Promise<string> {
  const output = await new Deno.Command(args[0], {
    args: args.slice(1),
    cwd: options.cwd ?? repository,
    env: options.env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  if (options.expectFailure !== undefined) {
    if (output.success) {
      throw new Error(`${args.join(" ")} succeeded but should have failed`);
    }
    if (!stderr.includes(options.expectFailure)) {
      throw new Error(
        `${args.join(" ")} failed for another reason:\n${stdout}${stderr}`,
      );
    }
    return stderr;
  }
  if (!output.success) {
    throw new Error(`${args.join(" ")} failed:\n${stdout}${stderr}`);
  }
  return stdout.trim();
}

const prepareArguments = [
  Deno.execPath(),
  "run",
  "--allow-read",
  "--allow-write=build",
  "--allow-run=git,go",
  "scripts/release.ts",
  "--out",
  out,
  "--allow-dirty",
  "--allow-existing-tag",
];
const prepare = (...flags: string[]) =>
  command([...prepareArguments, ...flags]);

/** The digest lines SHA256SUMS must carry for a prepared candidate. */
async function checkAssets(candidate: string, candidateStem: string) {
  const archiveHash = await sha256(
    await Deno.readFile(`${candidate}/${candidateStem}.tgz`),
  );
  const manifestAsset = await Deno.readFile(
    `${candidate}/${candidateStem}.manifest.json`,
  );
  const manifestHash = await sha256(manifestAsset);
  const sbomBytes = await Deno.readFile(
    `${candidate}/${candidateStem}.spdx.json`,
  );
  const sbomHash = await sha256(sbomBytes);
  const sums = await Deno.readTextFile(`${candidate}/SHA256SUMS`);
  if (
    sums !==
      `${archiveHash}  ${candidateStem}.tgz\n${manifestHash}  ${candidateStem}.manifest.json\n${sbomHash}  ${candidateStem}.spdx.json\n`
  ) throw new Error(`${candidateStem}: SHA256SUMS does not list the assets`);
  const packagedManifest = await Deno.readFile(
    `${candidate}/package/manifest.json`,
  );
  if (await sha256(packagedManifest) !== manifestHash) {
    throw new Error(
      `${candidateStem}: manifest asset differs from package/manifest.json`,
    );
  }
  // The standard idiom must pass on the download directory alone, before any
  // extraction: every listed file is a published asset.
  await command([
    "bash",
    "-c",
    "if command -v sha256sum >/dev/null 2>&1; then sha256sum -c SHA256SUMS; else shasum -a 256 -c SHA256SUMS; fi",
  ], { cwd: candidate });
  const sbom = JSON.parse(new TextDecoder().decode(sbomBytes));
  if (
    sbom.spdxVersion !== "SPDX-2.3" || sbom.SPDXID !== "SPDXRef-DOCUMENT" ||
    sbom.packages?.[0]?.checksums?.[0]?.checksumValue !== archiveHash ||
    sbom.relationships?.[0]?.relationshipType !== "DESCRIBES" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(sbom.creationInfo?.created)
  ) throw new Error(`${candidateStem}: SBOM does not describe the archive`);
  const names: string[] = sbom.packages.map((pkg: { name: string }) =>
    pkg.name
  );
  const namespace: string = sbom.documentNamespace;
  return { archiveHash, manifestHash, sbomHash, names, namespace };
}

function codeBlocks(markdown: string, info: string): string[] {
  const blocks: string[] = [];
  let current: string[] | undefined;
  for (const line of markdown.split("\n")) {
    if (current) {
      if (/^```/.test(line)) {
        blocks.push(current.join("\n") + "\n");
        current = undefined;
      } else current.push(line);
    } else if (line === "```" + info) current = [];
  }
  return blocks;
}

/**
 * Runs the README's `ts example` blocks from the package root and its
 * `sh example` blocks from the directory that holds package/, as the README
 * tells the reader to.
 */
async function runReadmeExamples(
  extracted: string,
  expected: { ts?: RegExp; sh?: string[] },
): Promise<string[]> {
  const readme = await Deno.readTextFile(`${extracted}/README.md`);
  const checks: string[] = [];
  const tsBlocks = codeBlocks(readme, "ts example");
  const shBlocks = codeBlocks(readme, "sh example");
  if ((expected.ts !== undefined) !== (tsBlocks.length > 0)) {
    throw new Error(`${extracted}: unexpected number of ts example blocks`);
  }
  if ((expected.sh !== undefined) !== (shBlocks.length > 0)) {
    throw new Error(`${extracted}: unexpected number of sh example blocks`);
  }
  for (const [index, block] of tsBlocks.entries()) {
    const file = `readme-example-${index}.ts`;
    await Deno.writeTextFile(`${extracted}/${file}`, block);
    try {
      const output = await command([
        Deno.execPath(),
        "run",
        "--check",
        "--no-config",
        "--cached-only",
        "--no-prompt",
        "--allow-read=.",
        file,
      ], { cwd: extracted });
      if (!expected.ts!.test(output)) {
        throw new Error(`${file} printed unexpected output:\n${output}`);
      }
    } finally {
      await Deno.remove(`${extracted}/${file}`);
    }
    checks.push(`packaged README TypeScript example ${index} ran with --check`);
  }
  const parent = extracted.slice(0, extracted.lastIndexOf("/"));
  for (const [index, block] of shBlocks.entries()) {
    await Deno.writeTextFile(
      `${parent}/example.capnp`,
      "@0xece4bf9c1f867623; struct Example { value @0 :Text; }\n",
    );
    await command(["bash", "-euo", "pipefail", "-c", block], { cwd: parent });
    for (const path of expected.sh!) {
      const stat = await Deno.stat(`${parent}/${path}`).catch(() => undefined);
      if (!stat?.isFile || stat.size === 0) {
        throw new Error(`README shell example ${index} did not write ${path}`);
      }
    }
    await Deno.remove(`${parent}/work`, { recursive: true });
    await Deno.remove(`${parent}/example.capnp`);
    checks.push(`packaged README shell example ${index} ran under Wasmtime`);
  }
  return checks;
}

async function checkLinks(extracted: string) {
  await command([
    Deno.execPath(),
    "run",
    "--allow-read",
    `${repository}/scripts/check-links.ts`,
  ], { cwd: extracted });
}

async function checkNotices(extracted: string, absent: string[]) {
  const notices = await Deno.readTextFile(
    `${extracted}/THIRD_PARTY_NOTICES.md`,
  );
  if (!notices.startsWith("# Third-party notices for ")) {
    throw new Error("packaged THIRD_PARTY_NOTICES.md is not the notices file");
  }
  for await (const entry of Deno.readDir(`${extracted}/licenses`)) {
    if (
      entry.name.startsWith("THIRD_PARTY_NOTICES") ||
      entry.name === "components.json"
    ) throw new Error(`licenses/ still contains ${entry.name}`);
  }
  for (const path of absent) {
    const stat = await Deno.stat(`${extracted}/${path}`).catch(() => undefined);
    if (stat) throw new Error(`${extracted} contains ${path}`);
  }
  for (const line of notices.split("\n")) {
    const file = /^ {2}- (\S+)$/.exec(line)?.[1];
    if (
      file && !await Deno.stat(`${extracted}/licenses/${file}`).catch(() => 0)
    ) {
      throw new Error(`notices name a missing license text: ${file}`);
    }
  }
}

// Candidates: the full SDK twice (with a stale file in between) and the tools
// archive twice, comparing bytes.
await prepare();
const full1 = await checkAssets(directory, stem);
const original = await verifyRelease(`${directory}/package`);
await Deno.writeTextFile(
  `${directory}/package/stale-from-previous-build`,
  "stale",
);
await prepare();
const full2 = await checkAssets(directory, stem);
if (full1.archiveHash !== full2.archiveHash) {
  throw new Error(
    "release archive is not reproducible for the same source and assets",
  );
}
if (full1.sbomHash !== full2.sbomHash) {
  throw new Error("SBOM is not reproducible for the same source and assets");
}
await prepare(tools.flag!);
const tools1 = await checkAssets(toolsDirectory, toolsStem);
await prepare(tools.flag!);
const tools2 = await checkAssets(toolsDirectory, toolsStem);
if (tools1.archiveHash !== tools2.archiveHash) {
  throw new Error("tools-only archive is not reproducible");
}
if (
  !full1.names.includes("@bjorn3/browser_wasi_shim") ||
  tools1.names.includes("@bjorn3/browser_wasi_shim") ||
  !tools1.names.includes("wasi-sdk")
) throw new Error("SBOM components are not selected per flavor");
if (
  ![full1, tools1].every((assets) => assets.namespace.endsWith("/candidate"))
) {
  throw new Error(
    "a candidate SBOM shares the publishable document namespace",
  );
}
const originalHash = full1.archiveHash;
const toolsHash = tools1.archiveHash;

// Publish mode: the candidate flags are rejected outright, and a build is
// refused unless the tree is clean and HEAD carries the release tag. At a
// tagged, clean commit (the release workflow's situation) the probe succeeds
// and must produce the same archive bytes as the candidate.
const probeOut = `${out}/publish-probe`;
const publishArguments = [
  Deno.execPath(),
  "run",
  "--allow-read",
  "--allow-write=build",
  "--allow-run=git,go",
  "scripts/release.ts",
  "--out",
  probeOut,
];
await command([...publishArguments, "--publish", "--allow-dirty"], {
  expectFailure: "not accepted with --publish",
});
const probe = await new Deno.Command(publishArguments[0], {
  args: [...publishArguments.slice(1), "--publish"],
  cwd: repository,
  stdin: "null",
  stdout: "piped",
  stderr: "piped",
}).output();
const probeStderr = new TextDecoder().decode(probe.stderr);
const probeOutput = await Deno.stat(`${repository}/${probeOut}/${stem}`).catch(
  () => undefined,
);
if (probe.success) {
  if (original.source.dirty) {
    throw new Error("publish mode accepted a dirty producer tree");
  }
  const published = await checkAssets(
    `${repository}/${probeOut}/${stem}`,
    stem,
  );
  if (
    published.namespace !== full1.namespace.slice(0, -"/candidate".length)
  ) {
    throw new Error(
      "publishable SBOM namespace is not the candidate's without /candidate",
    );
  }
  if (published.archiveHash !== originalHash) {
    throw new Error(
      "publish mode produced a different archive than candidate mode",
    );
  }
  await Deno.remove(`${repository}/${probeOut}`, { recursive: true });
} else if (
  !(original.source.dirty
    ? probeStderr.includes("refusing to publish from a working tree")
    : probeStderr.includes(`is not tagged capnpc-wasm-v${metadata.version}`))
) {
  throw new Error(`publish mode failed for another reason:\n${probeStderr}`);
} else if (probeOutput) {
  throw new Error("a refused publish left output behind");
}

const temporary = await Deno.realPath(
  await Deno.makeTempDir({
    dir: `${repository}/build/test`,
    prefix: "capnpc-wasm-package-",
  }),
);
try {
  await command(["cmake", "-E", "tar", "xzf", archive], { cwd: temporary });
  const extracted = `${temporary}/package`;
  await verifyRelease(extracted);
  // The shipped verifier, run from the checkout, with every option.
  const verifier = [
    Deno.execPath(),
    "run",
    "--allow-read",
    "scripts/verify-release.ts",
  ];
  await command([
    ...verifier,
    "--sums",
    `${directory}/SHA256SUMS`,
    "--expect-manifest-sha256",
    full1.manifestHash,
    "--expect-commit",
    original.source.commit,
    ...(original.source.dirty ? [] : ["--require-clean"]),
    extracted,
  ]);
  await command([
    ...verifier,
    "--expect-manifest-sha256",
    "0".repeat(64),
    extracted,
  ], { expectFailure: "does not match the expected" });
  await command([
    ...verifier,
    "--expect-commit",
    "0".repeat(40),
    extracted,
  ], { expectFailure: "does not match the expected" });
  if (original.source.dirty) {
    await command([...verifier, "--require-clean", extracted], {
      expectFailure: "dirty producer tree",
    });
  }
  // A SHA256SUMS without the manifest asset cannot tie the package to a
  // published manifest, so --sums refuses it even when its lines check out.
  const partialSums = `${temporary}/partial-sums`;
  await Deno.mkdir(partialSums);
  const placeholder = new TextEncoder().encode("not the archive\n");
  await Deno.writeFile(`${partialSums}/${stem}.tgz`, placeholder);
  await Deno.writeTextFile(
    `${partialSums}/SHA256SUMS`,
    `${await sha256(placeholder)}  ${stem}.tgz\n`,
  );
  await command(
    [...verifier, "--sums", `${partialSums}/SHA256SUMS`, extracted],
    {
      expectFailure: "lists no manifest asset",
    },
  );
  const packageMetadata = JSON.parse(
    await Deno.readTextFile(`${extracted}/package.json`),
  );
  if (packageMetadata.license !== "Apache-2.0") {
    throw new Error("package does not declare the Apache-2.0 project license");
  }
  if (!packageMetadata.files.includes("THIRD_PARTY_NOTICES.md")) {
    throw new Error("package.json files omit THIRD_PARTY_NOTICES.md");
  }
  const projectLicense = await Deno.readTextFile("LICENSE");
  if (!projectLicense.includes("Version 2.0, January 2004")) {
    throw new Error("project license is not Apache 2.0");
  }
  for (
    const path of ["LICENSE", "sdk/go/LICENSE", "licenses/capnpc-wasm-LICENSE"]
  ) {
    if (await Deno.readTextFile(`${extracted}/${path}`) !== projectLicense) {
      throw new Error(`packaged ${path} differs from the project license`);
    }
  }
  await checkNotices(extracted, []);
  // Every non-test Go source ships.
  for await (const entry of Deno.readDir("sdk/go")) {
    if (
      entry.isFile && entry.name.endsWith(".go") &&
      !entry.name.endsWith("_test.go") &&
      !await Deno.stat(`${extracted}/sdk/go/${entry.name}`).catch(() => 0)
    ) throw new Error(`packaged Go SDK omits ${entry.name}`);
  }
  // Packaged documents: no relative link may leave the package, and the
  // README examples must run as written.
  await checkLinks(extracted);
  const readme = await Deno.readTextFile(`${extracted}/README.md`);
  if (
    !readme.includes(`# @nullstyle/capnpc-wasm ${metadata.version}`) ||
    !readme.includes(original.source.commit) || readme.includes("{{")
  ) throw new Error("packaged README is not the rendered template");
  const guide = await Deno.readTextFile(`${extracted}/docs/typescript.md`);
  if (
    !guide.includes(
      `https://github.com/nullstyle/capnpc-wasm/blob/${original.source.commit}/examples/browser/README.md`,
    )
  ) {
    throw new Error(
      "packaged TypeScript guide keeps repository-relative links",
    );
  }
  const exampleChecks = await runReadmeExamples(extracted, {
    ts: /pub mod person/,
    sh: ["work/request.bin", "work/output/example.capnp.h"],
  });
  const manifestPath = `${extracted}/manifest.json`;
  const manifestBytes = await Deno.readFile(manifestPath);
  const altered = JSON.parse(new TextDecoder().decode(manifestBytes));
  altered.files[0].sha256 = "0".repeat(64);
  await Deno.writeTextFile(manifestPath, JSON.stringify(altered));
  let rejected = false;
  try {
    await verifyRelease(extracted);
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error("tampered manifest passed integrity verification");
  }
  await Deno.writeFile(manifestPath, manifestBytes);
  await Deno.writeTextFile(`${extracted}/unexpected`, "extra");
  rejected = false;
  try {
    await verifyRelease(extracted);
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error("unexpected package file passed integrity verification");
  }
  await Deno.remove(`${extracted}/unexpected`);
  await verifyRelease(extracted);
  const consumer = `${temporary}/consumer`;
  await Deno.mkdir(`${consumer}/node_modules/@nullstyle`, { recursive: true });
  await Deno.rename(
    extracted,
    `${consumer}/node_modules/@nullstyle/capnpc-wasm`,
  );
  const installed = `${consumer}/node_modules/@nullstyle/capnpc-wasm`;
  await checkLauncher(installed);
  const toolsConsumer = `${temporary}/tools consumer`;
  await Deno.mkdir(toolsConsumer);
  await command(["cmake", "-E", "tar", "xzf", toolsArchive], {
    cwd: toolsConsumer,
  });
  const toolsInstalled = `${toolsConsumer}/package`;
  const toolsManifest = await verifyRelease(toolsInstalled);
  if (
    toolsManifest.files.some((file) =>
      file.path.startsWith("typescript/") || file.path.startsWith("sdk/") ||
      file.path.startsWith("wasm/capnpc-") || file.path.startsWith("docs/")
    )
  ) throw new Error("tools-only package contains SDK or generator modules");
  await checkNotices(toolsInstalled, [
    "licenses/browser_wasi_shim-LICENSE-MIT",
    "licenses/zig-LICENSE",
    "licenses/go-LICENSE",
  ]);
  await checkLinks(toolsInstalled);
  const toolsReadme = await Deno.readTextFile(`${toolsInstalled}/README.md`);
  if (
    !toolsReadme.includes(
      `# @nullstyle/capnp-wasm-tools ${metadata.version}`,
    ) || toolsReadme.includes("{{")
  ) throw new Error("packaged tools README is not the rendered template");
  const toolsExampleChecks = await runReadmeExamples(toolsInstalled, {
    sh: ["work/request.bin"],
  });
  await checkLauncher(toolsInstalled, installed);
  await Deno.copyFile("tests/package/consumer.ts", `${consumer}/consumer.ts`);
  await Deno.copyFile("tests/package/main.go", `${consumer}/main.go`);
  await Deno.writeTextFile(
    `${consumer}/schema.capnp`,
    '@0xece4bf9c1f867623; using Go = import "/go.capnp"; $Go.package("candidate"); $Go.import("example.com/candidate"); struct Candidate { value @0 :Text; }\n',
  );
  await Deno.writeTextFile(
    `${consumer}/deno.json`,
    JSON.stringify({
      nodeModulesDir: "manual",
      compilerOptions: { strict: true },
    }),
  );
  await command([
    Deno.execPath(),
    "run",
    "--check",
    "--cached-only",
    "--no-prompt",
    `--allow-read=${consumer}`,
    `--allow-write=${consumer}/deno-result.json`,
    "consumer.ts",
  ], { cwd: consumer });
  await Deno.writeTextFile(
    `${consumer}/go.mod`,
    "module example.com/package-consumer\n\ngo 1.25.0\n\nrequire github.com/nullstyle/capnpc-wasm/sdk/go v0.0.0\n",
  );
  await command([
    "go",
    "mod",
    "edit",
    `-replace=github.com/nullstyle/capnpc-wasm/sdk/go=${installed}/sdk/go`,
  ], { cwd: consumer });
  await command(["go", "mod", "tidy"], { cwd: consumer });
  const dependency = JSON.parse(
    await command([
      "go",
      "list",
      "-m",
      "-json",
      "github.com/tetratelabs/wazero",
    ], { cwd: consumer }),
  );
  if (
    dependency.Replace ||
    dependency.Version !== "v1.12.1-0.20260908083515-451613caac44"
  ) {
    throw new Error(
      "external consumer is not using the pinned public wazero dependency",
    );
  }
  await command(["go", "run", "-mod=readonly", ".", installed], {
    cwd: consumer,
  });
  const deno = JSON.parse(
    await Deno.readTextFile(`${consumer}/deno-result.json`),
  );
  const go = JSON.parse(await Deno.readTextFile(`${consumer}/go-result.json`));
  if (
    JSON.stringify(Object.entries(deno).sort()) !==
      JSON.stringify(Object.entries(go).sort())
  ) {
    throw new Error(
      "external Go and Deno package consumers produced different bytes",
    );
  }
  await Deno.writeTextFile(
    "build/test/package-receipt.json",
    JSON.stringify(
      {
        version: metadata.version,
        source: original.source,
        archiveSha256: originalHash,
        manifestSha256: full1.manifestHash,
        sbomSha256: full1.sbomHash,
        toolsArchiveSha256: toolsHash,
        checks: [
          "candidates prepared under build/test, not dist/releases",
          "Apache-2.0 package and Go module licenses, THIRD_PARTY_NOTICES.md, per-flavor license texts",
          "manifest integrity, manifest asset, and SBOM listed in SHA256SUMS; sha256sum -c on the download directory",
          "reproducible archive and SBOM; candidate SBOM namespace distinct from the publishable one",
          "stale staging cleanup",
          "publish mode refuses candidate flags and an untagged HEAD",
          "verifier --sums (manifest asset required), --expect-manifest-sha256, --expect-commit, and --require-clean",
          "tampered manifest rejection",
          "unexpected file rejection",
          "every non-test Go source packaged",
          "packaged documents link only inside the package or to the repository at the producer commit",
          ...exampleChecks,
          ...toolsExampleChecks,
          "external Wasmtime launcher compiler/C++/Zig and canonicalization",
          "launcher paths with spaces, argument failures, and runtime pin",
          "reproducible tools-only archive with external generator modules",
          "external npm-layout TypeScript declarations",
          "external npm-layout Deno direct/replay and worker execution or explicit runtime rejection",
          "external Go compile/replay",
          "public pinned wazero without replacement",
          "cross-SDK generated-byte parity",
        ],
        generated: deno,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Package checks passed: ${metadata.version}, ${
      Object.keys(deno).length - 1
    } generated files; receipt build/test/package-receipt.json`,
  );
} finally {
  await Deno.remove(temporary, { recursive: true });
}
