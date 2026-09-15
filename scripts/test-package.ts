import { sha256, verifyRelease } from "./verify-release.ts";
import { checkLauncher } from "../tests/package/launcher.ts";

const repository = Deno.cwd();
const metadata = JSON.parse(await Deno.readTextFile("release.json"));
const stem = `capnpc-wasm-${metadata.version}`;
const directory = `${repository}/dist/releases/${stem}`;
const archive = `${directory}/${stem}.tgz`;
async function command(args: string[], cwd = repository): Promise<string> {
  const output = await new Deno.Command(args[0], {
    args: args.slice(1),
    cwd,
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
}
const originalHash = await sha256(await Deno.readFile(archive));
const receipt = await Deno.readTextFile(`${directory}/SHA256SUMS`);
if (!receipt.startsWith(`${originalHash}  ${stem}.tgz\n`)) {
  throw new Error("archive does not match SHA256SUMS");
}
const original = await verifyRelease(`${directory}/package`);
const toolsStem = `capnp-wasm-tools-${metadata.version}`;
const toolsDirectory = `${repository}/dist/releases/${toolsStem}`;
const toolsArchive = `${toolsDirectory}/${toolsStem}.tgz`;
const prepareTools = [
  "deno",
  "run",
  "--allow-read",
  "--allow-write=dist",
  "--allow-run=git,go",
  "scripts/release.ts",
  "--tools-only",
];
await command(prepareTools);
const toolsHash = await sha256(await Deno.readFile(toolsArchive));
await command(prepareTools);
if (await sha256(await Deno.readFile(toolsArchive)) !== toolsHash) {
  throw new Error("tools-only archive is not reproducible");
}
if (
  !receipt.includes(
    `${await sha256(
      await Deno.readFile(`${directory}/package/manifest.json`),
    )}  package/manifest.json\n`,
  )
) throw new Error("manifest does not match SHA256SUMS");
// Rebuild from the same source and assets; a stale file must not survive staging.
await Deno.writeTextFile(
  `${directory}/package/stale-from-previous-build`,
  "stale",
);
await command([
  "deno",
  "run",
  "--allow-read",
  "--allow-write=dist",
  "--allow-run=git,go",
  "scripts/release.ts",
]);
if (await sha256(await Deno.readFile(archive)) !== originalHash) {
  throw new Error(
    "release archive is not reproducible for the same source and assets",
  );
}
const temporary = await Deno.realPath(
  await Deno.makeTempDir({ prefix: "capnpc-wasm-package-" }),
);
try {
  await command(["cmake", "-E", "tar", "xzf", archive], temporary);
  const extracted = `${temporary}/package`;
  await verifyRelease(extracted);
  const packageMetadata = JSON.parse(
    await Deno.readTextFile(`${extracted}/package.json`),
  );
  if (packageMetadata.license !== "Apache-2.0") {
    throw new Error("package does not declare the Apache-2.0 project license");
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
  await command(["cmake", "-E", "tar", "xzf", toolsArchive], toolsConsumer);
  const toolsInstalled = `${toolsConsumer}/package`;
  const toolsManifest = await verifyRelease(toolsInstalled);
  if (
    toolsManifest.files.some((file) =>
      file.path.startsWith("typescript/") || file.path.startsWith("sdk/") ||
      file.path.startsWith("wasm/capnpc-")
    )
  ) throw new Error("tools-only package contains SDK or generator modules");
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
    "deno",
    "run",
    "--check",
    "--cached-only",
    "--no-prompt",
    `--allow-read=${consumer}`,
    `--allow-write=${consumer}/deno-result.json`,
    "consumer.ts",
  ], consumer);
  await Deno.writeTextFile(
    `${consumer}/go.mod`,
    "module example.com/package-consumer\n\ngo 1.25.0\n\nrequire github.com/nullstyle/capnpc-wasm/sdk/go v0.0.0\n",
  );
  await command([
    "go",
    "mod",
    "edit",
    `-replace=github.com/nullstyle/capnpc-wasm/sdk/go=${installed}/sdk/go`,
  ], consumer);
  await command(["go", "mod", "tidy"], consumer);
  const dependency = JSON.parse(
    await command([
      "go",
      "list",
      "-m",
      "-json",
      "github.com/tetratelabs/wazero",
    ], consumer),
  );
  if (
    dependency.Replace ||
    dependency.Version !== "v1.12.1-0.20260908083515-451613caac44"
  ) {
    throw new Error(
      "external consumer is not using the pinned public wazero dependency",
    );
  }
  await command(["go", "run", "-mod=readonly", ".", installed], consumer);
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
  await Deno.mkdir("build/test", { recursive: true });
  await Deno.writeTextFile(
    "build/test/package-receipt.json",
    JSON.stringify(
      {
        version: metadata.version,
        source: original.source,
        archiveSha256: originalHash,
        toolsArchiveSha256: toolsHash,
        checks: [
          "Apache-2.0 package and Go module licenses",
          "manifest integrity",
          "reproducible archive",
          "stale staging cleanup",
          "tampered manifest rejection",
          "unexpected file rejection",
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
