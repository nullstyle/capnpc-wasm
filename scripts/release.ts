import {
  packageFiles,
  type ReleaseManifest,
  sha256,
  verifyRelease,
} from "./verify-release.ts";

const metadata = JSON.parse(await Deno.readTextFile("release.json"));
const toolsOnly = Deno.args.includes("--tools-only");
if (Deno.args.some((arg) => arg !== "--tools-only")) {
  throw new Error("usage: release.ts [--tools-only]");
}
if (toolsOnly) metadata.name = "@nullstyle/capnp-wasm-tools";
if (
  !/^\d+\.\d+\.\d+-rc\.\d+$/.test(metadata.version) ||
  metadata.private !== true || metadata.license !== "Apache-2.0"
) throw new Error("invalid private release-candidate metadata");
const stem = `${
  toolsOnly ? "capnp-wasm-tools" : "capnpc-wasm"
}-${metadata.version}`;
const destination = `dist/releases/${stem}`;
const staging = `dist/releases/.${stem}.staging`;
await Deno.mkdir("dist/releases", { recursive: true });
await Deno.remove(staging, { recursive: true }).catch((error) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});
await Deno.mkdir(`${staging}/package`, { recursive: true });
const pkg = `${staging}/package`;
async function command(args: string[]): Promise<string> {
  const output = await new Deno.Command(args[0], {
    args: args.slice(1),
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `${args.join(" ")}: ${new TextDecoder().decode(output.stderr)}`,
    );
  }
  return new TextDecoder().decode(output.stdout).trimEnd();
}
async function copy(source: string, target: string) {
  await Deno.mkdir(
    `${pkg}/${
      target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : ""
    }`,
    { recursive: true },
  );
  await Deno.copyFile(source, `${pkg}/${target}`);
}
async function copyTree(source: string, target: string) {
  for (const path of await packageFiles(source)) {
    await copy(`${source}/${path}`, `${target}/${path}`);
  }
}
try {
  for (
    const directory of toolsOnly
      ? ["include", "licenses"]
      : ["typescript", "wasm", "include", "licenses"]
  ) {
    await copyTree(`dist/${directory}`, directory);
  }
  if (toolsOnly) await copy("dist/wasm/capnp.wasm", "wasm/capnp.wasm");
  await copy("bin/capnp-wasm", "bin/capnp-wasm");
  const wasmtimeVersion = /^wasmtime = "([0-9]+\.[0-9]+\.[0-9]+)"$/m.exec(
    await Deno.readTextFile("mise.toml"),
  )?.[1];
  if (!wasmtimeVersion) {
    throw new Error("missing exact Wasmtime pin in mise.toml");
  }
  await Deno.mkdir(`${pkg}/runtime`, { recursive: true });
  await Deno.writeTextFile(
    `${pkg}/runtime/wasmtime-version`,
    `${wasmtimeVersion}\n`,
  );
  if (!toolsOnly) {
    for (
      const path of [
        "compiler.go",
        "memoryfs.go",
        "go.mod",
        "go.sum",
        "README.md",
        "LICENSE",
      ]
    ) await copy(`sdk/go/${path}`, `sdk/go/${path}`);
  }
  await copy("scripts/verify-release.ts", "verify-release.ts");
  await copy("mise.toml", "provenance/mise.toml");
  await copy("mise.lock", "provenance/mise.lock");
  if (!toolsOnly) {
    await copy(
      "generators/zig/historical-reference",
      "provenance/zig-historical-reference",
    );
  }
  await copy("docs/releases.md", "README.md");
  await copy("docs/releases.md", "docs/releases.md");
  if (!toolsOnly) await copy("sdk/typescript/README.md", "docs/typescript.md");
  await copy("LICENSE", "LICENSE");
  await Deno.writeTextFile(
    `${pkg}/package.json`,
    JSON.stringify(
      {
        ...metadata,
        type: "module",
        description:
          "Cap'n Proto compiler and generators for browser workers, Deno, and WASI hosts",
        ...(toolsOnly ? {} : {
          main: "./typescript/mod.js",
          types: "./typescript/mod.d.ts",
        }),
        exports: toolsOnly
          ? {
            "./wasm/*": "./wasm/*",
            "./include/*": "./include/*",
            "./manifest.json": "./manifest.json",
          }
          : {
            ".": {
              types: "./typescript/mod.d.ts",
              import: "./typescript/mod.js",
            },
            "./worker": "./typescript/worker.js",
            "./wasm/*": "./wasm/*",
            "./include/*": "./include/*",
            "./manifest.json": "./manifest.json",
          },
        files: [
          "bin",
          "runtime",
          ...(toolsOnly ? [] : ["typescript", "sdk/go"]),
          "wasm",
          "include",
          "licenses",
          "provenance",
          "docs",
          "manifest.json",
          "verify-release.ts",
          "LICENSE",
          "README.md",
        ],
        repository: {
          type: "git",
          url: "git+https://github.com/nullstyle/capnpc-wasm.git",
        },
      },
      null,
      2,
    ) + "\n",
  );
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
  await Deno.writeTextFile(
    `${pkg}/provenance/sources.json`,
    JSON.stringify(sources, null, 2) + "\n",
  );
  const references: Record<string, string> = {};
  for (
    const line of (await command(["git", "ls-files", "--stage", "ref"])).split(
      "\n",
    )
  ) {
    const match = /^160000 ([0-9a-f]{40}) 0\t(.+)$/.exec(line);
    if (!match) continue;
    const actual = await command(["git", "-C", match[2], "rev-parse", "HEAD"]);
    if (actual !== match[1]) {
      throw new Error(
        `reference checkout differs from pinned gitlink: ${match[2]}`,
      );
    }
    references[match[2]] = actual;
  }
  if (!toolsOnly) {
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
    await Deno.writeTextFile(
      `${pkg}/provenance/go-dependency.json`,
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
  const manifest: ReleaseManifest = {
    format: 1,
    name: metadata.name,
    version: metadata.version,
    source: {
      commit: await command(["git", "rev-parse", "HEAD"]),
      dirty: !!await command(["git", "status", "--porcelain"]),
      sha256: sourceHash,
    },
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
  await Deno.writeTextFile(
    `${pkg}/manifest.json`,
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await verifyRelease(pkg);
  // Minimal deterministic POSIX ustar: sorted files, normalized metadata, no
  // symlinks, timestamps, host names, or platform-dependent tar extensions.
  const chunks: Uint8Array[] = [];
  for (const path of await packageFiles(pkg)) {
    const bytes = await Deno.readFile(`${pkg}/${path}`);
    const header = new Uint8Array(512);
    const name = new TextEncoder().encode(`package/${path}`);
    if (name.length > 100) throw new Error(`archive path too long: ${path}`);
    header.set(name);
    const field = (offset: number, width: number, value: number) =>
      header.set(
        new TextEncoder().encode(
          value.toString(8).padStart(width - 1, "0") + "\0",
        ),
        offset,
      );
    field(100, 8, 0o644);
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
  const manifestBytes = await Deno.readFile(`${pkg}/manifest.json`);
  await Deno.writeTextFile(
    `${staging}/SHA256SUMS`,
    `${await sha256(archive)}  ${stem}.tgz\n${await sha256(
      manifestBytes,
    )}  package/manifest.json\n`,
  );
  await Deno.remove(destination, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  await Deno.rename(staging, destination);
  console.log(
    `Prepared private ${metadata.name}@${metadata.version}: ${destination}/${stem}.tgz`,
  );
} catch (error) {
  await Deno.remove(staging, { recursive: true }).catch(() => {});
  throw error;
}
