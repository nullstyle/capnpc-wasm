// Stages the SDK bundle's Wasm modules, standard schemas, and third-party
// notices under dist/ (or the staging directory build-sdk.sh passes).
//
// Notices are derived per artifact from a component map: the reference
// checkouts under ref/, the toolchains whose standard libraries are linked
// (Go, Rust, Zig), the WASI SDK sysroot's wasi-libc and LLVM runtimes (texts
// vendored under third_party/wasi-sdk-34 and verified against ref/wasi-sdk's
// nested gitlinks), the Go modules `go list -deps` reports for the wasip1
// build, and the crates `cargo metadata` resolves for wasm32-wasip1. A
// component without a license text fails the staging. Every flavor gets a
// THIRD_PARTY_NOTICES-<flavor>.md listing its artifacts' components and the
// files that hold their texts, and components.json records the same map for
// release packaging.

const destination = Deno.args[0] ?? "dist";
if (
  !/^dist(?:\/[a-zA-Z0-9_.-]+)*$/.test(destination) ||
  destination.split("/").some((part) => part === "..")
) throw new Error("asset destination must stay under dist/");

async function command(args: string[], env?: Record<string, string>) {
  const result = await new Deno.Command(args[0], {
    args: args.slice(1),
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}
// build-sdk.sh grants go, rustc, and mise; cargo and git run through mise
// exec so the grant stays as it is.
const viaMise = (args: string[], env?: Record<string, string>) =>
  command(["mise", "exec", "--", ...args], env);

for (const directory of ["wasm", "include", "licenses"]) {
  await Deno.remove(`${destination}/${directory}`, { recursive: true }).catch(
    (error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    },
  );
}
// The SDK never searches a native installation for modules or standard schemas.
// Keep this local bundle paired with the exact binaries tested by the suite.
const modules = [
  "capnp",
  "capnpc-c++",
  "capnpc-capnp",
  "capnpc-rust",
  "capnpc-go",
  "capnpc-zig",
];
const schemas = [
  "c++.capnp",
  "schema.capnp",
  "stream.capnp",
  "rpc.capnp",
  "rpc-twoparty.capnp",
  "persistent.capnp",
  "compat/json.capnp",
  "compat/byte-stream.capnp",
  "compat/http-over-capnp.capnp",
  "compat/json-rpc.capnp",
];

async function copy(source: string, target: string) {
  await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
    recursive: true,
  });
  try {
    await Deno.copyFile(source, target);
  } catch (error) {
    throw new Error(`cannot copy ${source}: ${(error as Error).message}`);
  }
}

for (const name of modules) {
  await copy(`build/wasm/bin/${name}.wasm`, `${destination}/wasm/${name}.wasm`);
}
for (const name of schemas) {
  await copy(
    `ref/capnproto/c++/src/capnp/${name}`,
    `${destination}/include/capnp/${name}`,
  );
}
await copy("ref/go-capnp/std/go.capnp", `${destination}/include/go.capnp`);

// Components ------------------------------------------------------------------

interface LicenseFile {
  /** Where the text is read from. */
  source: string;
  /** Where it lands, relative to licenses/. */
  target: string;
}

interface Component {
  name: string;
  /** What was built or copied: a reference commit, a toolchain, a module. */
  origin: string;
  /** SPDX expression, or a pointer to the files when none is recorded. */
  license: string;
  files: LicenseFile[];
}

const root = Deno.cwd();

async function gitlink(name: string): Promise<string> {
  return await viaMise(["git", "rev-parse", `:ref/${name}`]);
}

async function reference(
  name: string,
  title: string,
  license: string,
  files: string[],
): Promise<Component> {
  return {
    name: title,
    origin: `ref/${name} at ${(await gitlink(name)).slice(0, 12)}`,
    license,
    files: files.map((file) => ({
      source: `ref/${name}/${file}`,
      target: `${name}-${file}`,
    })),
  };
}

const project: Component = {
  name: "capnpc-wasm",
  origin: "this repository",
  license: "Apache-2.0",
  files: [{ source: "LICENSE", target: "capnpc-wasm-LICENSE" }],
};
const capnproto = await reference(
  "capnproto",
  "Cap'n Proto (C++ runtime, compiler, and generators)",
  "MIT",
  ["LICENSE"],
);
const capnprotoRust = await reference(
  "capnproto-rust",
  "capnproto-rust (capnp and capnpc crates)",
  "MIT",
  ["LICENSE"],
);
const goCapnp = await reference(
  "go-capnp",
  "go-capnp (capnproto.org/go/capnp/v3)",
  "MIT",
  ["LICENSE"],
);
const capnpZig = await reference("capnp-zig", "capnp-zig", "MIT", ["LICENSE"]);
const browserWasiShim = await reference(
  "browser_wasi_shim",
  "@bjorn3/browser_wasi_shim",
  "MIT OR Apache-2.0",
  ["LICENSE-MIT", "LICENSE-APACHE"],
);
const wasiSdk = await reference(
  "wasi-sdk",
  "WASI SDK 34 (toolchain build scripts and CMake files)",
  "Apache-2.0 WITH LLVM-exception",
  ["LICENSE"],
);

const goRoot = await command(["go", "env", "GOROOT"]);
const goVersion = await command(["go", "env", "GOVERSION"]);
const rustSysroot = await command(["rustc", "--print", "sysroot"]);
const rustVersion = await command(["rustc", "--version"]);
const zigRoot = await command(["mise", "where", "zig"]);
const zigVersion = zigRoot.slice(zigRoot.lastIndexOf("/") + 1);
const goStd: Component = {
  name: "Go standard library and runtime",
  origin: goVersion,
  license: "BSD-3-Clause",
  files: [{ source: `${goRoot}/LICENSE`, target: "go-LICENSE" }],
};
const rustStd: Component = {
  name: "Rust standard library",
  origin: rustVersion,
  license:
    "MIT OR Apache-2.0, with the third-party notices in the file (its wasm32-wasip1 build links the toolchain's own wasi-libc; see the wasi-libc component)",
  files: [{
    source: `${rustSysroot}/share/doc/rust/COPYRIGHT-library.html`,
    target: "rust-COPYRIGHT-library.html",
  }],
};
const zigStd: Component = {
  name: "Zig standard library",
  origin: `Zig ${zigVersion}`,
  license: "MIT",
  files: [{ source: `${zigRoot}/LICENSE`, target: "zig-LICENSE" }],
};

// The sysroot's runtimes ship no license texts; the vendored copies are the
// files at the wasi-libc and llvm-project commits that ref/wasi-sdk records,
// checked by digest and against those gitlinks.
async function sha256(path: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await Deno.readFile(path),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
interface VendoredManifest {
  sdk: string;
  sources: Record<
    string,
    {
      repository: string;
      gitlink: string;
      commit: string;
      files: Record<string, string>;
    }
  >;
}
const vendoredDir = "third_party/wasi-sdk-34";
const vendored = JSON.parse(
  await Deno.readTextFile(`${vendoredDir}/manifest.json`),
) as VendoredManifest;
const sdkPin = /^version = "([0-9]+)"$/m.exec(
  (await Deno.readTextFile("mise.toml")).split("[tools.wasi-sdk]")[1] ?? "",
)?.[1];
if (sdkPin !== vendored.sdk) {
  throw new Error(
    `mise.toml pins wasi-sdk ${sdkPin} but ${vendoredDir} holds the notices for wasi-sdk ${vendored.sdk}; refresh it (see its README)`,
  );
}
async function vendoredFiles(source: string): Promise<LicenseFile[]> {
  const entry = vendored.sources[source];
  const recorded = await viaMise([
    "git",
    "-C",
    "ref/wasi-sdk",
    "rev-parse",
    `HEAD:${entry.gitlink}`,
  ]);
  if (recorded !== entry.commit) {
    throw new Error(
      `${vendoredDir} holds ${source} notices for commit ${entry.commit} but ref/wasi-sdk records ${recorded} at ${entry.gitlink}; refresh it (see its README)`,
    );
  }
  const files: LicenseFile[] = [];
  for (const [path, digest] of Object.entries(entry.files)) {
    const local = `${vendoredDir}/${source}/${path}`;
    if (await sha256(local) !== digest) {
      throw new Error(`${local} does not match the digest in manifest.json`);
    }
    files.push({ source: local, target: `wasi-sdk-34/${source}/${path}` });
  }
  return files;
}
const wasiLibc: Component = {
  name:
    "wasi-libc (with musl, cloudlibc, dlmalloc, and musl-fts portions; the WASI SDK sysroot's libc)",
  origin: `WebAssembly/wasi-libc at ${
    vendored.sources["wasi-libc"].commit.slice(0, 12)
  }, as recorded by ref/wasi-sdk`,
  license:
    "Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT; musl MIT; cloudlibc BSD-2-Clause; dlmalloc CC0-1.0; musl-fts BSD-3-Clause",
  files: await vendoredFiles("wasi-libc"),
};
const llvmRuntimes: Component = {
  name:
    "libc++, libc++abi, libunwind, and compiler-rt builtins (the WASI SDK sysroot's C++ runtime)",
  origin: `llvm/llvm-project at ${
    vendored.sources["llvm-project"].commit.slice(0, 12)
  }, as recorded by ref/wasi-sdk`,
  license: "Apache-2.0 WITH LLVM-exception",
  files: await vendoredFiles("llvm-project"),
};

/** SPDX labels for modules and crates the build graph pulls in. */
const knownLicenses: Record<string, string> = {
  "github.com/colega/zeropool": "Apache-2.0",
  "github.com/tetratelabs/wazero": "Apache-2.0",
  "golang.org/x/sync": "BSD-3-Clause",
  "golang.org/x/sys": "BSD-3-Clause",
};
const licenseFileName = /^(license|licence|copying|notice)(\.|-|$)/i;

async function licenseFilesIn(directory: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isFile && licenseFileName.test(entry.name)) {
      found.push(entry.name);
    }
  }
  return found.sort();
}

/** Modules `go list -deps` reports for a package, minus the references. */
async function goModules(
  directory: string,
  packages: string[],
  env: Record<string, string>,
): Promise<Component[]> {
  const output = await command([
    "go",
    "-C",
    directory,
    "list",
    "-deps",
    "-f",
    "{{if .Module}}{{.Module.Path}}\t{{.Module.Version}}\t{{.Module.Dir}}{{end}}",
    ...packages,
  ], { GOFLAGS: "-mod=readonly", ...env });
  const components: Component[] = [];
  const seen = new Set<string>();
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [path, version, dir] = line.split("\t");
    if (seen.has(path)) continue;
    seen.add(path);
    // The reference checkouts have their own components, and the project's
    // own modules need none. The module cache (GOPATH under .cache/) is the
    // only place below the root that holds third-party modules.
    if (dir.startsWith(`${root}/ref/`)) continue;
    if (dir.startsWith(`${root}/`) && !dir.includes("/pkg/mod/")) continue;
    const files = await licenseFilesIn(dir);
    if (files.length === 0) {
      throw new Error(`Go module ${path}@${version} ships no license file`);
    }
    components.push({
      name: path,
      origin: `Go module ${path}@${version}`,
      license: knownLicenses[path] ?? "see the listed files",
      // One version per module path in a build graph, so the directory omits
      // the version (a pseudo-version would exceed the archive path limit);
      // the notices and components.json record it.
      files: files.map((file) => ({
        source: `${dir}/${file}`,
        target: `go-modules/${path}/${file}`,
      })),
    });
  }
  return components;
}

/** Crates cargo resolves for the wasm32-wasip1 build, minus the references. */
async function rustCrates(manifest: string): Promise<Component[]> {
  interface Metadata {
    packages: {
      id: string;
      name: string;
      version: string;
      license: string | null;
      license_file: string | null;
      source: string | null;
      manifest_path: string;
    }[];
    resolve: {
      root: string;
      nodes: {
        id: string;
        deps: { pkg: string; dep_kinds: { kind: string | null }[] }[];
      }[];
    };
  }
  const metadata = JSON.parse(
    await viaMise([
      "cargo",
      "metadata",
      "--locked",
      "--format-version",
      "1",
      "--manifest-path",
      manifest,
      "--filter-platform",
      "wasm32-wasip1",
    ]),
  ) as Metadata;
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const linked = new Set<string>();
  const walk = (id: string) => {
    if (linked.has(id)) return;
    linked.add(id);
    for (const dep of nodes.get(id)!.deps) {
      if (dep.dep_kinds.some((kind) => kind.kind === null)) walk(dep.pkg);
    }
  };
  walk(metadata.resolve.root);
  const components: Component[] = [];
  for (const id of [...linked].sort()) {
    const pkg = packages.get(id)!;
    if (id === metadata.resolve.root) continue;
    const dir = pkg.manifest_path.slice(0, pkg.manifest_path.lastIndexOf("/"));
    if (dir.startsWith(`${root}/ref/`)) continue;
    const files = await licenseFilesIn(dir);
    if (pkg.license_file && !files.includes(pkg.license_file)) {
      files.push(pkg.license_file);
    }
    if (files.length === 0) {
      throw new Error(`crate ${pkg.name} ${pkg.version} ships no license file`);
    }
    components.push({
      name: pkg.name,
      origin: `crate ${pkg.name} ${pkg.version} (${pkg.source ?? "path"})`,
      license: pkg.license ?? "see the listed files",
      files: files.map((file) => ({
        source: `${dir}/${file}`,
        target: `rust-crates/${pkg.name}-${pkg.version}/${file}`,
      })),
    });
  }
  return components;
}

const generatorGoModules = await goModules(
  "generators/go",
  ["capnproto.org/go/capnp/v3/capnpc-go"],
  { GOOS: "wasip1", GOARCH: "wasm" },
);
const sdkGoModules = await goModules("sdk/go", ["./..."], {});
const generatorCrates = await rustCrates("generators/rust/Cargo.toml");

// Artifacts and flavors -------------------------------------------------------

interface Artifact {
  path: string;
  description: string;
  components: Component[];
}

const cppComponents = [capnproto, wasiLibc, llvmRuntimes, wasiSdk];
const artifacts: Artifact[] = [
  {
    path: "wasm/capnp.wasm",
    description: "the schema compiler",
    components: cppComponents,
  },
  {
    path: "wasm/capnpc-c++.wasm",
    description: "the C++ generator",
    components: cppComponents,
  },
  {
    path: "wasm/capnpc-capnp.wasm",
    description: "the schema inspection generator",
    components: cppComponents,
  },
  {
    path: "wasm/capnpc-rust.wasm",
    description: "the Rust generator",
    components: [project, capnprotoRust, ...generatorCrates, rustStd, wasiLibc],
  },
  {
    path: "wasm/capnpc-go.wasm",
    description: "the Go generator",
    components: [goCapnp, ...generatorGoModules, goStd],
  },
  {
    path: "wasm/capnpc-zig.wasm",
    description: "the Zig generator",
    components: [capnpZig, zigStd],
  },
  {
    path: "include/",
    description: "the standard schemas",
    components: [capnproto, goCapnp],
  },
  {
    path: "typescript/",
    description: "the TypeScript SDK bundle",
    components: [project, browserWasiShim],
  },
  {
    path: "sdk/go/",
    description: "the Go SDK source",
    components: [project, ...sdkGoModules],
  },
  {
    path: "bin/capnp-wasm",
    description: "the Wasmtime launcher",
    components: [project],
  },
];
for (const artifact of artifacts) {
  if (artifact.components.length === 0) {
    throw new Error(`${artifact.path} has no components`);
  }
}
const byPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
const flavor = (paths: string[]) => paths.map((path) => byPath.get(path)!);
const flavors: Record<string, { title: string; artifacts: Artifact[] }> = {
  "capnpc-wasm": {
    title: "capnpc-wasm (full SDK archive)",
    artifacts,
  },
  "capnp-wasm-tools": {
    title: "capnp-wasm-tools (compiler and Wasmtime launcher)",
    artifacts: flavor(["wasm/capnp.wasm", "include/", "bin/capnp-wasm"]),
  },
  "capnp-wasm-compiler-host": {
    title: "capnp-wasm-compiler-host (compiler and TypeScript host)",
    artifacts: flavor(["wasm/capnp.wasm", "include/", "typescript/"]),
  },
};

// Staging ---------------------------------------------------------------------

const licenses = `${destination}/licenses`;
const staged = new Map<string, string>();
// scripts/release.ts writes ustar headers whose name field holds at most 100
// bytes; a longer path would fail there, after staging.
const archivePathLimit = 100;
for (const artifact of artifacts) {
  for (const component of artifact.components) {
    for (const file of component.files) {
      const archivePath = `licenses/${file.target}`;
      if (new TextEncoder().encode(archivePath).length > archivePathLimit) {
        throw new Error(
          `${archivePath} exceeds the ${archivePathLimit}-byte archive path limit; shorten the target name`,
        );
      }
      const previous = staged.get(file.target);
      if (previous !== undefined && previous !== file.source) {
        throw new Error(
          `${file.target} would be written from both ${previous} and ${file.source}`,
        );
      }
      if (previous === undefined) {
        await copy(file.source, `${licenses}/${file.target}`);
        staged.set(file.target, file.source);
      }
    }
  }
}

function notices(name: string, title: string, included: Artifact[]): string {
  const lines = [
    `# Third-party notices for ${title}`,
    "",
    "This package contains the components below. Each entry names the license",
    "and the files in this directory that hold its text and notices. The",
    "capnpc-wasm project itself is licensed under the Apache License, Version",
    "2.0 (LICENSE at the package root).",
    "",
  ];
  for (const artifact of included) {
    lines.push(`## ${artifact.path} (${artifact.description})`, "");
    for (const component of artifact.components) {
      lines.push(
        `- ${component.name}: ${component.origin}. License: ${component.license}.`,
        ...component.files.map((file) => `  - ${file.target}`),
      );
    }
    lines.push("");
  }
  lines.push(`Generated by scripts/package-assets.ts as ${name}.`, "");
  return lines.join("\n");
}

for (const [name, { title, artifacts: included }] of Object.entries(flavors)) {
  await Deno.writeTextFile(
    `${licenses}/THIRD_PARTY_NOTICES-${name}.md`,
    notices(`THIRD_PARTY_NOTICES-${name}.md`, title, included),
  );
}
await Deno.writeTextFile(
  `${licenses}/components.json`,
  JSON.stringify(
    {
      flavors: Object.fromEntries(
        Object.entries(flavors).map(([name, { artifacts: included }]) => [
          name,
          included.map((artifact) => artifact.path),
        ]),
      ),
      artifacts: artifacts.map((artifact) => ({
        path: artifact.path,
        description: artifact.description,
        components: artifact.components.map((component) => ({
          name: component.name,
          origin: component.origin,
          license: component.license,
          files: component.files.map((file) => file.target),
        })),
      })),
    },
    null,
    2,
  ) + "\n",
);
const componentCount = new Set(
  artifacts.flatMap((artifact) => artifact.components.map((c) => c.name)),
).size;
console.log(
  `Staged SDK modules, standard schemas, and notices for ${componentCount} components (${staged.size} license files) in ${destination}/`,
);
