import { packageFiles, sha256, verifyRelease } from "./verify-release.ts";

// Optional executable override verifies a supported older Deno without changing
// the producer's own toolchain pin. The default is the current test executable.
const deno = Deno.args[0] ?? Deno.execPath();
if (Deno.args.length > 1) {
  throw new Error("usage: test-compiler-host-package.ts [deno]");
}
const repository = Deno.cwd();
const metadata = JSON.parse(await Deno.readTextFile("release.json"));
const stem = `capnp-wasm-compiler-host-${metadata.version}`;
const directory = `${repository}/dist/releases/${stem}`;
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
const prepare = [
  Deno.execPath(),
  "run",
  "--allow-read",
  "--allow-write=dist",
  "--allow-run=git",
  "scripts/release.ts",
  "--compiler-host",
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
    "LICENSE",
    "licenses/capnpc-wasm-LICENSE",
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
    file.path.startsWith("bin/") || file.path.startsWith("runtime/")
  )
) throw new Error("compiler-host package contains unrelated tools or SDKs");
const checksums = await Deno.readTextFile(`${directory}/SHA256SUMS`);
const manifestHash = await sha256(
  await Deno.readFile(`${directory}/package/manifest.json`),
);
if (
  checksums !==
    `${archiveHash}  ${stem}.tgz\n${manifestHash}  package/manifest.json\n`
) {
  throw new Error("compiler-host checksum receipt does not match");
}
const temporary = await Deno.realPath(
  await Deno.makeTempDir({ prefix: "capnp-compiler-host-" }),
);
try {
  const consumer = `${temporary}/external consumer with spaces`;
  await Deno.mkdir(consumer);
  await command(["cmake", "-E", "tar", "xzf", archive], consumer);
  const extracted = `${consumer}/package`;
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
  await Deno.mkdir("build/test", { recursive: true });
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
        files: await packageFiles(installed),
        checks: [
          "reproducible archive and stale staging cleanup",
          "complete extraction inventory and identity",
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
