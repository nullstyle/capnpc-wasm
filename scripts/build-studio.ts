// Build the complete static Schema Studio website under dist/studio.
//
// The site is staged under dist/studio/.staging (the task's write grant covers
// dist/studio only) and swapped into place after every step succeeded, so a
// failed bundle, a missing license, or a stale CSP hash leaves the previous
// site untouched. Every asset URL carries a content hash of the staged site,
// only the modules Studio loads are shipped, and the licenses get an index
// page the app links to. The app stays independent of the SDK package.
const site = "dist/studio";
const staging = `${site}/.staging`;
const previous = `${site}/.previous`;
const modules = [
  "capnp.wasm",
  "capnpc-c++.wasm",
  "capnpc-rust.wasm",
  "capnpc-go.wasm",
  "capnpc-zig.wasm",
];
const sentinel = "__STUDIO_ASSET_VERSION__";
const encoder = new TextEncoder();

async function remove(path: string) {
  await Deno.remove(path, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
}

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

async function copyFile(source: string, target: string) {
  await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
    recursive: true,
  });
  await Deno.copyFile(source, target);
}

async function files(directory: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for await (const item of Deno.readDir(directory)) {
    if (item.isDirectory) {
      found.push(
        ...await files(`${directory}/${item.name}`, `${prefix}${item.name}/`),
      );
    } else if (item.isFile) found.push(`${prefix}${item.name}`);
  }
  return found.sort();
}

async function digest(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as BufferSource),
  );
}
const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** The CSP source that admits index.html's one inline boot script. */
export async function bootScriptHash(html: string): Promise<string> {
  const scripts = [
    ...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g),
  ];
  const inline = scripts.filter(([tag]) => !/\ssrc=/.test(tag.split(">")[0]));
  if (inline.length !== 1) {
    throw new Error(
      `index.html must contain exactly one inline script; found ${inline.length}`,
    );
  }
  return `sha256-${base64(await digest(encoder.encode(inline[0][1])))}`;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  ).replaceAll('"', "&quot;");
}

/** A static index of the shipped license files, linked from Studio's header. */
function licenseIndex(names: string[]): string {
  const items = names.map((name) =>
    `      <li><a href="./${encodeURIComponent(name)}">${
      escapeHtml(name)
    }</a></li>`
  ).join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Licenses · Schema Studio</title>
    <style>
      body { margin: 0 auto; max-width: 720px; padding: 32px 16px; font: 100%/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172d39; background: #f5f7f9; }
      a { color: #066875; }
      li { margin: 4px 0; overflow-wrap: anywhere; }
    </style>
  </head>
  <body>
    <h1>Third-party licenses</h1>
    <p>Schema Studio bundles the Cap’n Proto compiler and generators, their
      language runtimes and toolchains, the browser WASI shim, CodeMirror, and
      fflate. Their license texts follow. Project code is Apache-2.0
      (<code>capnpc-wasm-LICENSE</code>).</p>
    <ul>
${items}
    </ul>
    <p><a href="../../">Back to Schema Studio</a></p>
  </body>
</html>
`;
}

async function bundle() {
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
      `${staging}/main.js`,
      "examples/browser/main.js",
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!build.success) {
    throw new Error(`deno bundle exited with status ${build.code}`);
  }
}

// Deno resolves npm dependencies into the project-owned cache. Preserve the
// exact licenses belonging to the frozen editor/archive dependency graph.
async function stageDependencyLicenses(target: string) {
  const lock = JSON.parse(
    await Deno.readTextFile("examples/browser/deno.lock"),
  );
  const cache = Deno.env.get("DENO_DIR");
  if (!cache) {
    throw new Error(
      "Run through mise so DENO_DIR points at the project cache.",
    );
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
          `${target}/${name.replaceAll("/", "-")}-${version}-${item.name}`,
        );
        copied = true;
      }
    }
    if (!copied) {
      throw new Error(`Missing bundled dependency license: ${identity}`);
    }
  }
}

/** A short content hash over every staged file plus the page template. */
async function version(html: string): Promise<string> {
  const parts: string[] = [];
  for (const path of await files(staging)) {
    parts.push(
      `${path}\0${
        hex(await digest(await Deno.readFile(`${staging}/${path}`)))
      }`,
    );
  }
  parts.push(`index.html\0${hex(await digest(encoder.encode(html)))}`);
  return hex(await digest(encoder.encode(parts.join("\n")))).slice(0, 16);
}

async function stage(): Promise<string> {
  await Deno.mkdir(staging, { recursive: true });
  await bundle();
  for (const file of ["style.css", "favicon.svg"]) {
    await Deno.copyFile(`examples/browser/${file}`, `${staging}/${file}`);
  }
  const html = await Deno.readTextFile("examples/browser/index.html");
  const hash = await bootScriptHash(html);
  if (!html.includes(`'${hash}'`)) {
    throw new Error(
      `index.html's Content-Security-Policy must admit its boot script with '${hash}'; update the meta tag.`,
    );
  }
  for (const placeholder of ['data-version="dev"', 'href="./style.css"']) {
    if (!html.includes(placeholder)) {
      throw new Error(`index.html lacks the placeholder ${placeholder}`);
    }
  }
  for (const module of modules) {
    await copyFile(`dist/wasm/${module}`, `${staging}/assets/wasm/${module}`);
  }
  await copyTree("dist/include", `${staging}/assets/include`);
  await copyTree("dist/licenses", `${staging}/assets/licenses`);
  await copyFile(
    "dist/typescript/worker.js",
    `${staging}/assets/typescript/worker.js`,
  );
  await stageDependencyLicenses(`${staging}/assets/licenses`);
  await Deno.writeTextFile(
    `${staging}/assets/licenses/index.html`,
    licenseIndex(await files(`${staging}/assets/licenses`)),
  );
  const stamp = await version(html);
  const main = await Deno.readTextFile(`${staging}/main.js`);
  if (!main.includes(sentinel)) {
    throw new Error("the bundled main.js lacks the asset version sentinel");
  }
  await Deno.writeTextFile(
    `${staging}/main.js`,
    main.replaceAll(sentinel, stamp),
  );
  await Deno.writeTextFile(
    `${staging}/index.html`,
    html.replace('data-version="dev"', `data-version="${stamp}"`).replace(
      'href="./style.css"',
      `href="./style.css?v=${stamp}"`,
    ),
  );
  return stamp;
}

/** Move the staged site into place, restoring the old one if a move fails. */
async function publish() {
  await Deno.mkdir(previous);
  const moved: string[] = [];
  for await (const item of Deno.readDir(site)) {
    if (item.name === ".staging" || item.name === ".previous") continue;
    await Deno.rename(`${site}/${item.name}`, `${previous}/${item.name}`);
    moved.push(item.name);
  }
  try {
    for await (const item of Deno.readDir(staging)) {
      await Deno.rename(`${staging}/${item.name}`, `${site}/${item.name}`);
    }
  } catch (error) {
    for (const name of moved) {
      await remove(`${site}/${name}`);
      await Deno.rename(`${previous}/${name}`, `${site}/${name}`);
    }
    throw error;
  }
  await remove(previous);
  await remove(staging);
}

if (import.meta.main) {
  await Deno.mkdir(site, { recursive: true });
  await remove(staging);
  await remove(previous);
  let stamp: string;
  try {
    stamp = await stage();
  } catch (error) {
    await remove(staging);
    throw error;
  }
  await publish();
  console.log(
    `Built Schema Studio ${stamp} in dist/studio/ (serve over HTTP).`,
  );
}
