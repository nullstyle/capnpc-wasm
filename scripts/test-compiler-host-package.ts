// Verifies the compiler-host archive: the candidate is prepared into
// build/test/compiler-host (never dist/releases), checked for
// reproducibility and asset integrity, extracted into a fresh directory under
// build/test, and exercised by an external Deno consumer with a fresh cache,
// the packaged README example, and a link check over the packaged documents.
import { packageFiles, sha256, verifyRelease } from "./verify-release.ts";
import { archiveStem, flavorNamed, readMetadata } from "./release.ts";
import { compilerPathFixture } from "../tests/package/compiler-path-fixture.ts";

// Optional executable override verifies a supported older Deno without changing
// the producer's own toolchain pin. The default is the current test executable.
const deno = Deno.args[0] ?? Deno.execPath();
if (Deno.args.length > 1) {
  throw new Error("usage: test-compiler-host-package.ts [deno]");
}
const repository = Deno.cwd();
const flavor = flavorNamed("capnp-wasm-compiler-host");
const { version } = await readMetadata(flavor);
const out = "build/test/compiler-host";
const stem = archiveStem(flavor, version);
const directory = `${repository}/${out}/${stem}`;
const archive = `${directory}/${stem}.tgz`;
async function command(
  args: string[],
  cwd = repository,
  env?: Record<string, string>,
  timeoutMs = 60_000,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const output = await new Deno.Command(args[0], {
      args: args.slice(1),
      cwd,
      env,
      signal: controller.signal,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!output.success) {
      throw new Error(
        `${args.join(" ")} failed:\n${new TextDecoder().decode(output.stdout)}${
          new TextDecoder().decode(output.stderr)
        }`,
      );
    }
    return new TextDecoder().decode(output.stdout).trim();
  } finally {
    clearTimeout(timer);
  }
}
async function mustReject(root: string, label: string) {
  try {
    await verifyRelease(root);
  } catch {
    return;
  }
  throw new Error(`${label} passed verification`);
}
async function canonical(bytes: Uint8Array): Promise<Uint8Array> {
  const child = new Deno.Command(
    `${repository}/build/native/bin/normalize-request`,
    {
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(8000),
    },
  ).spawn();
  const output = child.output();
  const writer = child.stdin.getWriter();
  await writer.write(bytes);
  await writer.close();
  const normalized = await output;
  if (!normalized.success) {
    throw new Error(new TextDecoder().decode(normalized.stderr));
  }
  return normalized.stdout;
}

const prepare = [
  Deno.execPath(),
  "run",
  "--allow-read",
  "--allow-write=build",
  "--allow-run=git",
  "scripts/release.ts",
  flavor.flag!,
  "--out",
  out,
  "--allow-dirty",
  "--allow-existing-tag",
];
await command(prepare);
const archiveHash = await sha256(await Deno.readFile(archive));
await Deno.writeTextFile(`${directory}/package/stale-file`, "stale");
await command(prepare);
if (await sha256(await Deno.readFile(archive)) !== archiveHash) {
  throw new Error("compiler-host archive is not reproducible");
}
const manifest = await verifyRelease(`${directory}/package`);
if (manifest.name !== "@nullstyle/capnp-wasm-compiler-host") {
  throw new Error("wrong compiler-host package identity");
}
for (
  const required of [
    "typescript/mod.js",
    "typescript/mod.d.ts",
    "typescript/worker.js",
    "wasm/capnp.wasm",
    "include/capnp/schema.capnp",
    "include/capnp/stream.capnp",
    "docs/typescript.md",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "licenses/capnpc-wasm-LICENSE",
    "licenses/browser_wasi_shim-LICENSE-MIT",
    "provenance/sources.json",
    "verify-release.ts",
  ]
) {
  if (!manifest.files.some((file) => file.path === required)) {
    throw new Error(`missing ${required}`);
  }
}
if (
  manifest.files.some((file) =>
    file.path.startsWith("sdk/") || file.path.startsWith("wasm/capnpc-") ||
    file.path.startsWith("bin/") || file.path.startsWith("runtime/") ||
    file.path === "licenses/zig-LICENSE" || file.path === "licenses/go-LICENSE"
  )
) throw new Error("compiler-host package contains unrelated tools or SDKs");
const manifestHash = await sha256(
  await Deno.readFile(`${directory}/package/manifest.json`),
);
const manifestAssetHash = await sha256(
  await Deno.readFile(`${directory}/${stem}.manifest.json`),
);
const sbomBytes = await Deno.readFile(`${directory}/${stem}.spdx.json`);
const sbomHash = await sha256(sbomBytes);
// The SBOM names the archive at the flavor's version and the project's own
// code at the producer commit, and declares every component's license.
const sbomPackages = JSON.parse(new TextDecoder().decode(sbomBytes))
  .packages as {
    name: string;
    SPDXID: string;
    versionInfo?: string;
    licenseDeclared: string;
  }[];
const sbomComponents = sbomPackages.filter((pkg) =>
  pkg.SPDXID.startsWith("SPDXRef-Component-")
);
if (
  sbomPackages[0].versionInfo !== manifest.version ||
  sbomComponents.find((pkg) => pkg.name === "capnpc-wasm")?.versionInfo !==
    manifest.source.commit ||
  sbomComponents.some((pkg) => pkg.licenseDeclared === "NOASSERTION")
) {
  throw new Error(
    "compiler-host SBOM misnames the archive or the project's code, or leaves a license undeclared",
  );
}
if (
  manifestAssetHash !== manifestHash ||
  await Deno.readTextFile(`${directory}/SHA256SUMS`) !==
    `${archiveHash}  ${stem}.tgz\n${manifestHash}  ${stem}.manifest.json\n${sbomHash}  ${stem}.spdx.json\n`
) {
  throw new Error("compiler-host checksum receipt does not match the assets");
}
await Deno.mkdir("build/test", { recursive: true });
const temporary = await Deno.realPath(
  await Deno.makeTempDir({
    dir: `${repository}/build/test`,
    prefix: "capnp-compiler-host-",
  }),
);
try {
  const consumer = `${temporary}/external consumer with spaces`;
  await Deno.mkdir(consumer);
  await command(["cmake", "-E", "tar", "xzf", archive], consumer);
  const extracted = `${consumer}/package`;
  await verifyRelease(extracted);
  await command([
    Deno.execPath(),
    "run",
    "--allow-read",
    "scripts/verify-release.ts",
    "--sums",
    `${directory}/SHA256SUMS`,
    "--expect-manifest-sha256",
    manifestHash,
    "--expect-commit",
    manifest.source.commit,
    extracted,
  ]);
  // Packaged documents: every relative link resolves inside the package, and
  // the README example runs from the package root as written.
  await command([
    Deno.execPath(),
    "run",
    "--allow-read",
    `${repository}/scripts/check-links.ts`,
  ], extracted);
  const readme = await Deno.readTextFile(`${extracted}/README.md`);
  if (
    !readme.includes(`# ${manifest.name} ${manifest.version}`) ||
    !readme.includes(manifest.source.commit) || readme.includes("{{")
  ) throw new Error("packaged README is not the rendered template");
  const example = /^```ts example\n([\s\S]*?)^```$/m.exec(readme)?.[1];
  if (!example) throw new Error("packaged README has no ts example block");
  await Deno.writeTextFile(`${extracted}/readme-example.ts`, example);
  const exampleOutput = await command(
    [
      deno,
      "run",
      "--check",
      "--no-config",
      "--cached-only",
      "--no-prompt",
      "--allow-read=.",
      "readme-example.ts",
    ],
    extracted,
    { DENO_DIR: `${temporary}/fresh-deno-cache` },
  );
  if (!/^CodeGeneratorRequest: [1-9]\d* bytes$/.test(exampleOutput)) {
    throw new Error(
      `README example printed unexpected output: ${exampleOutput}`,
    );
  }
  await Deno.remove(`${extracted}/readme-example.ts`);
  await verifyRelease(extracted);
  const modulePath = `${extracted}/wasm/capnp.wasm`;
  const original = await Deno.readFile(modulePath);
  const changed = new Uint8Array(original);
  changed[changed.length - 1] ^= 1;
  await Deno.writeFile(modulePath, changed);
  await mustReject(extracted, "modified module");
  await Deno.remove(modulePath);
  await mustReject(extracted, "missing module");
  await Deno.writeFile(modulePath, original);
  await Deno.writeTextFile(`${extracted}/unexpected`, "extra");
  await mustReject(extracted, "unexpected file");
  await Deno.remove(`${extracted}/unexpected`);
  await verifyRelease(extracted);
  const installed =
    `${consumer}/node_modules/@nullstyle/capnp-wasm-compiler-host`;
  await Deno.mkdir(`${consumer}/node_modules/@nullstyle`, { recursive: true });
  await Deno.rename(extracted, installed);
  await Deno.copyFile(
    "tests/package/compiler-host-consumer.ts",
    `${consumer}/consumer.ts`,
  );
  await Deno.copyFile(
    "tests/package/compiler-path-fixture.ts",
    `${consumer}/compiler-path-fixture.ts`,
  );
  await Deno.writeTextFile(
    `${consumer}/deno.json`,
    JSON.stringify({
      nodeModulesDir: "manual",
      compilerOptions: { strict: true },
    }),
  );
  const output = await command(
    [
      deno,
      "run",
      "--check",
      "--cached-only",
      "--no-prompt",
      `--allow-read=${consumer}`,
      "consumer.ts",
    ],
    consumer,
    { DENO_DIR: `${temporary}/fresh-deno-cache` },
  );
  const result = JSON.parse(output);
  const nativeRoot = `${consumer}/native-paths`;
  for (const [path, contents] of Object.entries(compilerPathFixture.files)) {
    const target = `${nativeRoot}/${path}`;
    await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeFile(
      target,
      typeof contents === "string"
        ? new TextEncoder().encode(contents)
        : contents,
    );
  }
  for (const reverse of [false, true]) {
    const roots = [...compilerPathFixture.importPaths];
    if (reverse) roots.reverse();
    const native = await new Deno.Command(
      `${repository}/build/native/bin/capnp`,
      {
        cwd: nativeRoot,
        args: [
          "compile",
          "--no-standard-import",
          ...roots.map((path) => `-I${path}`),
          `--src-prefix=${compilerPathFixture.sourcePrefix}`,
          "-o-",
          ...compilerPathFixture.entrypoints,
        ],
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(8000),
      },
    ).output();
    if (!native.success) {
      throw new Error(new TextDecoder().decode(native.stderr));
    }
    const encoded = reverse ? result.reversedPathRequest : result.pathRequest;
    const guest = Uint8Array.from(
      atob(encoded),
      (value) => value.charCodeAt(0),
    );
    if (
      await sha256(await canonical(guest)) !==
        await sha256(await canonical(native.stdout))
    ) {
      throw new Error(
        `source-prefix/ordered-root native request parity failed (${reverse})`,
      );
    }
  }
  delete result.pathRequest;
  delete result.reversedPathRequest;
  result.checks.push(
    "complete canonical request parity with native compiler for both include orders",
  );
  if (result.deno === "2.6.8") {
    const termination = JSON.parse(
      await command(
        [
          deno,
          "run",
          "--no-config",
          "--no-prompt",
          `--allow-read=${repository}/tests/hosts/deno`,
          `${repository}/tests/hosts/deno/worker-termination-probe.ts`,
        ],
        repository,
        undefined,
        8000,
      ),
    );
    if (
      termination.continuedAfterThreeSeconds ||
      termination.afterThreeSeconds <= termination.atTermination
    ) throw new Error("Deno worker failed the bounded termination probe");
    result.checks.push(
      "Deno worker counter stopped within the engine termination grace",
    );
  }
  const receiptPath = `build/test/compiler-host-package-${result.deno}.json`;
  await Deno.writeTextFile(
    receiptPath,
    JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        source: manifest.source,
        archiveSha256: archiveHash,
        manifestSha256: manifestHash,
        sbomSha256: sbomHash,
        files: await packageFiles(installed),
        checks: [
          "candidate prepared under build/test, not dist/releases",
          "reproducible archive and stale staging cleanup",
          "complete extraction inventory and identity",
          "manifest asset and SBOM listed in SHA256SUMS; verifier --sums, --expect-manifest-sha256, and --expect-commit",
          "SBOM names the archive at its version and the project's own code at the producer commit, and declares every license",
          "flavor-specific license texts and THIRD_PARTY_NOTICES.md",
          "packaged documents link only inside the package or to the repository at the producer commit",
          "packaged README TypeScript example ran with --check",
          "modified, missing and unexpected file rejection and restored verification",
          "fresh external consumer cache with no private repository access",
          ...result.checks,
        ],
        consumer: result,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Compiler-host package checks passed on Deno ${result.deno}; receipt ${receiptPath}`,
  );
} finally {
  await Deno.remove(temporary, { recursive: true });
}
