// Keep the app independent of the SDK package: dist/studio is a complete static
// website, including its local worker, compiler, generators, and licenses.
const destination = "dist/studio";
await Deno.remove(destination, { recursive: true }).catch((error) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});
await Deno.mkdir(destination, { recursive: true });
async function copyTree(source: string, target: string) {
  await Deno.mkdir(target, { recursive: true });
  for await (const item of Deno.readDir(source)) {
    if (item.isDirectory) {
      await copyTree(`${source}/${item.name}`, `${target}/${item.name}`);
    } else if (item.isFile) {
      await Deno.copyFile(`${source}/${item.name}`, `${target}/${item.name}`);
    }
  }
}
const build = await new Deno.Command(Deno.execPath(), {
  args: [
    "bundle",
    "--config",
    "examples/browser/deno.json",
    "--frozen",
    "--unstable-sloppy-imports",
    "--platform",
    "browser",
    "--format",
    "esm",
    "--minify",
    "-o",
    `${destination}/main.js`,
    "examples/browser/main.js",
  ],
  stdout: "inherit",
  stderr: "inherit",
}).output();
if (!build.success) Deno.exit(build.code);
for (const file of ["index.html", "style.css", "favicon.svg"]) {
  await Deno.copyFile(`examples/browser/${file}`, `${destination}/${file}`);
}
for (const directory of ["wasm", "include", "licenses"]) {
  await copyTree(`dist/${directory}`, `${destination}/assets/${directory}`);
}
await Deno.mkdir(`${destination}/assets/typescript`, { recursive: true });
await Deno.copyFile(
  "dist/typescript/worker.js",
  `${destination}/assets/typescript/worker.js`,
);

// Deno resolves npm dependencies into the project-owned cache. Preserve the
// exact licenses belonging to the frozen editor/archive dependency graph.
const lock = JSON.parse(await Deno.readTextFile("examples/browser/deno.lock"));
const cache = Deno.env.get("DENO_DIR");
if (!cache) {
  throw new Error("Run through mise so DENO_DIR points at the project cache.");
}
for (const identity of Object.keys(lock.npm)) {
  const split = identity.lastIndexOf("@");
  const name = identity.slice(0, split);
  const version = identity.slice(split + 1);
  const path = `${cache}/npm/registry.npmjs.org/${name}/${version}`;
  let copied = false;
  for await (const item of Deno.readDir(path)) {
    if (item.isFile && /^(license|copying)(\.|$)/i.test(item.name)) {
      await Deno.copyFile(
        `${path}/${item.name}`,
        `${destination}/assets/licenses/${
          name.replaceAll("/", "-")
        }-${version}-${item.name}`,
      );
      copied = true;
    }
  }
  if (!copied) {
    throw new Error(`Missing bundled dependency license: ${identity}`);
  }
}
console.log("Built Schema Studio in dist/studio/ (serve over HTTP).");
