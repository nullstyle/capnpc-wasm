/// <reference lib="dom" />
import { chromium, firefox, webkit } from "./playwright.ts";
import type { Page } from "playwright";
import { selectedEngines } from "./engines.ts";
import { checkWorkerRaces } from "./studio-worker-races.js";
import { unzipSync } from "fflate";
import { Buffer } from "node:buffer";
import { securityHeaders, serveStudio } from "../../scripts/serve-example.ts";
import { presets } from "../../examples/browser/presets.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const root = Deno.cwd();
await Deno.mkdir("build/test", { recursive: true });
const evidence = await Deno.makeTempDir({
  dir: "build/test",
  prefix: "studio-",
});
const fixture = `${root}/${evidence}/native`;
await Deno.mkdir(`${evidence}/tmp`);
Deno.env.set("TMPDIR", `${root}/${evidence}/tmp`);
await Deno.mkdir(`${fixture}/src/types`, { recursive: true });
for (const [path, source] of Object.entries(presets[0].files)) {
  await Deno.writeTextFile(`${fixture}/src/${path}`, source);
}
async function command(
  bin: string,
  args: string[],
  cwd: string,
  stdin?: Uint8Array,
) {
  const process = new Deno.Command(bin, {
    args,
    cwd,
    stdin: stdin ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(60_000),
  }).spawn();
  const output = process.output();
  if (stdin) {
    const writer = process.stdin.getWriter();
    await writer.write(stdin);
    await writer.close();
  }
  const result = await output;
  assert(result.success, decoder.decode(result.stderr));
  return result.stdout;
}
const request = await command(`${root}/build/native/bin/capnp`, [
  "compile",
  "--no-standard-import",
  `-I${root}/dist/include`,
  `--src-prefix=${fixture}/src`,
  "-o-",
  ...Object.keys(presets[0].files),
], `${fixture}/src`);
const expected = new Map<string, Uint8Array>();
async function collect(directory: string, prefix: string) {
  for await (const item of Deno.readDir(directory)) {
    if (item.isDirectory) {
      await collect(`${directory}/${item.name}`, `${prefix}/${item.name}`);
    } else {expected.set(
        `${prefix}/${item.name}`,
        await Deno.readFile(`${directory}/${item.name}`),
      );}
  }
}
for (
  const [language, generator] of Object.entries({
    cpp: "c++",
    rust: "rust",
    go: "go",
    zig: "zig",
  })
) {
  const output = `${fixture}/${language}`;
  await Deno.mkdir(output, { recursive: true });
  await command(
    `${root}/build/native/bin/capnpc-${generator}`,
    [],
    output,
    request,
  );
  await collect(output, language);
}

// The pinned axe-core from tests/browser/deno.json, served from this origin so
// the scan runs under the page's own Content-Security-Policy.
const axeSpecifier: string = JSON.parse(
  await Deno.readTextFile("tests/browser/deno.json"),
).imports["axe-core"];
const axeVersion = /^npm:axe-core@(\d+\.\d+\.\d+)$/.exec(axeSpecifier)?.[1];
assert(axeVersion, `unexpected axe-core specifier ${axeSpecifier}`);
const axeSource = await Deno.readTextFile(
  `${
    Deno.env.get("DENO_DIR")
  }/npm/registry.npmjs.org/axe-core/${axeVersion}/axe.min.js`,
);

const server = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen() {} },
  (request) => {
    if (new URL(request.url).pathname === "/__axe.js") {
      return new Response(axeSource, {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    }
    return serveStudio(request);
  },
);
const url = `http://127.0.0.1:${server.addr.port}/`;

// The server's own guards: loopback Host names only, no hidden paths, and the
// headers a meta tag cannot carry. A raw socket sends the Host header as is.
async function rawRequest(host: string, path = "/"): Promise<string> {
  const connection = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.addr.port,
  });
  await connection.write(
    encoder.encode(
      `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
    ),
  );
  const chunks: Uint8Array[] = [];
  for await (const chunk of connection.readable) chunks.push(chunk);
  return decoder.decode(
    new Uint8Array(chunks.flatMap((chunk) => [...chunk])),
  ).split("\r\n\r\n")[0].toLowerCase();
}
const foreign = await rawRequest("studio.example");
assert(foreign.startsWith("http/1.1 421"), `foreign Host served: ${foreign}`);
const local = await rawRequest(`127.0.0.1:${server.addr.port}`);
assert(local.startsWith("http/1.1 200"), `loopback Host refused: ${local}`);
for (const [name, value] of Object.entries(securityHeaders)) {
  assert(
    local.includes(`${name}: ${value.toLowerCase()}`),
    `missing ${name} header: ${local}`,
  );
}
assert(
  (await fetch(`${url}.staging/index.html`)).status === 404 &&
    (await fetch(`${url}assets/.hidden`)).status === 404,
  "hidden paths served",
);
const headersChecked = Object.keys(securityHeaders);

type AxeResult = {
  violations: {
    id: string;
    impact: string;
    help: string;
    nodes: { target: string[] }[];
  }[];
  passes: unknown[];
  incomplete: {
    id: string;
    nodes: { target: string[]; any: { message: string }[] }[];
  }[];
};
async function scanAccessibility(page: Page, output: string, name: string) {
  await page.addScriptTag({ url: `${url}__axe.js` });
  const result = await page.evaluate(async () => {
    // deno-lint-ignore no-explicit-any
    const axe = (globalThis as any).axe;
    return await axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
    }) as AxeResult;
  });
  const violations = result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.slice(0, 5).map((node) => node.target.join(" ")),
  }));
  await Deno.writeTextFile(
    `${output}/axe-${name}.json`,
    JSON.stringify(
      {
        axeVersion,
        violations,
        passes: result.passes.length,
        // Nodes axe could not decide, with its reason, so a reviewer can
        // check them by hand.
        incomplete: result.incomplete.map((rule) => ({
          id: rule.id,
          nodes: rule.nodes.slice(0, 8).map((node) => ({
            target: node.target.join(" "),
            reason: node.any.map((check) => check.message).join("; "),
          })),
        })),
      },
      null,
      2,
    ) + "\n",
  );
  assert(
    violations.length === 0,
    `axe violations (${name}): ${JSON.stringify(violations)}`,
  );
  return { name, passes: result.passes.length, violations: 0 };
}
const activeId = (page: Page) =>
  page.evaluate(() => document.activeElement?.id ?? "");
const badgeIs = (page: Page, text: string) =>
  page.waitForFunction(
    (text) => document.querySelector("#output-badge")?.textContent === text,
    text,
  );
const idle = (page: Page) =>
  page.waitForFunction(() => document.body.dataset.busy === "false");
const generateAll = async (page: Page) => {
  await page.locator("#generate-all").click();
  await page.waitForFunction(() =>
    document.body.dataset.busy === "false" &&
    document.querySelector("#status")?.textContent?.includes(
      "C++, Rust, Go, Zig",
    )
  );
};

try {
  for (const engine of selectedEngines(Deno.args)) {
    const output = `${evidence}/${engine}`;
    await Deno.mkdir(output, { recursive: true });
    const browser = await { chromium, firefox, webkit }[engine].launch({
      headless: true,
    });
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        acceptDownloads: true,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      const errors: string[] = [];
      const requested: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => requested.push(request.url()));
      page.on("dialog", (dialog) => dialog.accept());
      await page.goto(url);
      await badgeIs(page, "Up to date");
      assert(
        !requested.some((path) => /capnpc-(rust|go|zig)\.wasm/.test(path)),
        `${engine}: eagerly fetched unselected generators`,
      );
      assert(
        requested.some((path) => /\/main\.js\?v=[0-9a-f]{16}$/.test(path)) &&
          requested.some((path) =>
            /\/assets\/wasm\/capnp\.wasm\?v=[0-9a-f]{16}$/.test(path)
          ),
        `${engine}: asset URLs are not versioned: ${requested.join(" ")}`,
      );
      assert(
        await page.getByRole("button", {
          name: "Edit types/common.capnp",
          exact: true,
        }).count() === 1,
        "Multi-file workspace missing",
      );
      assert(
        await page.locator("h1").count() === 1 &&
          await page.getByRole("link", { name: "Licenses" }).count() === 1,
        `${engine}: page heading or Licenses link missing`,
      );
      assert(
        (await fetch(`${url}assets/licenses/index.html`)).status === 200,
        `${engine}: license index missing`,
      );
      await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
      const axeInitial = await scanAccessibility(page, output, "initial");

      await generateAll(page);
      assert(
        (await page.locator("#timing").innerText()).includes("Schema reused"),
        "Language changes recompiled the workspace",
      );
      const downloadPromise = page.waitForEvent("download");
      await page.locator("#download-all").click();
      const download = await downloadPromise;
      const zipPath = `${output}/outputs.zip`;
      await download.saveAs(zipPath);
      const entries = unzipSync(await Deno.readFile(zipPath));
      assert(
        Object.keys(entries).length === expected.size,
        `${engine}: generated file count differs from native`,
      );
      for (const [path, bytes] of expected) {
        assert(
          entries[path]?.length === bytes.length &&
            bytes.every((byte, i) => entries[path][i] === byte),
          `${engine}: ${path} differs from native`,
        );
      }
      // Every language is loaded now: switching between them neither fetches
      // a module again nor rebuilds the worker (the races check counts
      // workers; here the network is the witness).
      const moduleRequests = () =>
        requested.filter((path) => /\.wasm\?v=/.test(path)).length;
      const loadedModules = moduleRequests();
      assert(loadedModules === 5, `${engine}: expected five module fetches`);
      for (const language of ["rust", "go", "zig", "cpp"]) {
        await page.locator(`#tab-${language}`).click();
        assert(
          await page.locator("#output-files").isEnabled(),
          `${engine}: missing ${language} file browser`,
        );
      }
      assert(
        moduleRequests() === loadedModules,
        `${engine}: switching loaded languages fetched modules again`,
      );
      const onePromise = page.waitForEvent("download");
      await page.locator("#download-file").click();
      const one = await onePromise;
      await one.saveAs(`${output}/${one.suggestedFilename()}`);
      const selected = await page.locator("#output-files").inputValue();
      const oneBytes = await Deno.readFile(
        `${output}/${one.suggestedFilename()}`,
      );
      assert(
        expected.get(`cpp/${selected}`)?.every((byte, i) =>
          oneBytes[i] === byte
        ),
        "Single download differs",
      );
      const axeOutput = await scanAccessibility(page, output, "output");

      // Keyboard: arrows only move focus between tabs (manual activation),
      // Enter selects, and Generate keeps focus while it runs and afterwards.
      await page.locator("#tab-cpp").focus();
      await page.keyboard.press("ArrowRight");
      assert(
        await activeId(page) === "tab-rust" &&
          await page.locator("#tab-cpp").getAttribute("aria-selected") ===
            "true",
        `${engine}: arrow key did not move focus without selecting`,
      );
      await page.keyboard.press("End");
      assert(await activeId(page) === "tab-zig", `${engine}: End key`);
      await page.keyboard.press("ArrowRight");
      assert(await activeId(page) === "tab-cpp", `${engine}: arrow wrap`);
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Enter");
      assert(
        await page.locator("#tab-zig").getAttribute("aria-selected") ===
            "true" &&
          await page.locator("#output-badge").textContent() === "Up to date",
        `${engine}: Enter did not select the focused tab`,
      );
      // A regeneration with everything loaded takes milliseconds, so the
      // page itself samples focus when the busy flag flips on and off.
      await page.locator("#generate").focus();
      await page.evaluate(() => {
        type Sample = { active: string; disabled: string | null };
        const record: { during?: Sample; after?: Sample } = {};
        (globalThis as { focusRecord?: typeof record }).focusRecord = record;
        const sample = (): Sample => ({
          active: document.activeElement?.id ?? "",
          disabled: document.querySelector("#generate")!.getAttribute(
            "aria-disabled",
          ),
        });
        new MutationObserver(() => {
          const busy = document.body.dataset.busy;
          if (busy === "true" && !record.during) record.during = sample();
          if (busy === "false" && record.during && !record.after) {
            record.after = sample();
          }
        }).observe(document.body, {
          attributes: true,
          attributeFilter: ["data-busy"],
        });
      });
      await page.keyboard.press("Enter");
      await page.waitForFunction(() =>
        (globalThis as { focusRecord?: { after?: unknown } }).focusRecord
          ?.after !== undefined
      );
      await idle(page);
      const focusRecord = await page.evaluate(() =>
        (globalThis as {
          focusRecord?: {
            during?: { active: string; disabled: string | null };
            after?: { active: string; disabled: string | null };
          };
        }).focusRecord
      );
      assert(
        focusRecord?.during?.active === "generate" &&
          focusRecord.during.disabled === "true",
        `${engine}: focus left Generate during the run: ${
          JSON.stringify(focusRecord)
        }`,
      );
      assert(
        focusRecord.after?.active === "generate" &&
          focusRecord.after.disabled === "false" &&
          await activeId(page) === "generate",
        `${engine}: focus left Generate after the run: ${
          JSON.stringify(focusRecord)
        }`,
      );
      await page.locator("#tab-cpp").click();

      // Edits keep the undo history when files are added, and a new schema
      // carries the annotations every generator needs.
      await page.getByRole("button", {
        name: "Edit types/common.capnp",
        exact: true,
      }).click();
      const changed = presets[0].files["types/common.capnp"]!.replace(
        "online @2 :Bool = false;",
        "online @2 :Bool = false;\n  nickname @3 :Text;",
      );
      const source = page.getByRole("textbox", {
        name: "Schema source",
        exact: true,
      });
      await source.fill(changed);
      await badgeIs(page, "Changes to generate");
      assert(
        await page.locator("#download-all").isDisabled(),
        `${engine}: stale results remained downloadable`,
      );
      await page.getByRole("button", { name: "Edit chat.capnp", exact: true })
        .click();
      await page.getByRole("button", {
        name: "Edit types/common.capnp",
        exact: true,
      }).click();
      assert(
        (await page.locator("#source-editor").innerText()).includes("nickname"),
        "Switching files lost edits",
      );
      await page.locator("#add-file").click();
      await page.locator("#file-path").fill("../escape.capnp");
      await page.locator("#file-submit").click();
      assert(
        (await page.locator("#file-error").innerText()).includes(
          "relative path",
        ),
        "Traversal file path accepted",
      );
      await page.locator("#file-path").fill("types/new.capnp");
      await page.locator("#file-submit").click();
      await page.getByRole("button", {
        name: "Edit types/new.capnp",
        exact: true,
      }).waitFor();
      const editorText = () => page.locator("#source-editor").innerText();
      const template = await editorText();
      assert(
        template.includes('$Go.package("new");') &&
          template.includes('$Go.import("example.com/studio/chat/types");') &&
          template.includes('$Cxx.namespace("studio");'),
        `${engine}: new file template lacks annotations: ${template}`,
      );
      await page.getByRole("button", {
        name: "Edit types/common.capnp",
        exact: true,
      }).click();
      await source.focus();
      await page.keyboard.press("ControlOrMeta+z");
      assert(
        !(await editorText()).includes("nickname"),
        `${engine}: undo history was lost when a file was added`,
      );
      await source.fill(changed);
      await page.locator("#generate").click();
      await badgeIs(page, "Up to date");
      await page.locator("#output-files").selectOption("types/common.capnp.h");
      const changedPromise = page.waitForEvent("download");
      await page.locator("#download-file").click();
      await (await changedPromise).saveAs(`${output}/changed.h`);
      assert(
        (await Deno.readTextFile(`${output}/changed.h`)).includes("Nickname"),
        "Imported schema edit did not affect output",
      );
      await generateAll(page);
      await page.locator("#tab-go").click();
      assert(
        await page.locator("#output-files option", {
          hasText: "types/new.capnp.go",
        }).count() === 1,
        `${engine}: Generate all skipped the new file's Go output`,
      );
      await page.locator("#tab-cpp").click();
      await page.getByRole("button", {
        name: "Edit types/new.capnp",
        exact: true,
      }).click();
      await page.locator("#rename-file").click();
      await page.locator("#file-path").fill("types/renamed.capnp");
      await page.locator("#file-submit").click();
      await page.getByRole("button", {
        name: "Edit types/renamed.capnp",
        exact: true,
      }).waitFor();
      await page.locator("#remove-file").click();
      await page.locator("#confirm-action").click();
      await page.getByRole("button", {
        name: "Edit types/renamed.capnp",
        exact: true,
      }).waitFor({ state: "detached" });
      await page.locator("#generate").click();
      await badgeIs(page, "Up to date");

      // A guest failure shows the SDK's message above the raw diagnostics.
      await page.getByRole("button", {
        name: "Edit types/common.capnp",
        exact: true,
      }).click();
      await source.fill("this is not a schema");
      await page.locator("#generate").click();
      await badgeIs(page, "Generation failed");
      assert(
        (await page.locator("#diagnostics-text").innerText()).includes(
          "common.capnp",
        ),
        "Compiler source diagnostics lost",
      );
      const header = await page.locator("#diagnostics-error").innerText();
      assert(
        /^compiler exited with status \d+/.test(header),
        `${engine}: failure header missing: ${JSON.stringify(header)}`,
      );
      assert(
        await page.locator("#download-all").isDisabled(),
        "Failed compile exposed old output",
      );
      await source.fill(changed);
      await page.locator("#generate").click();
      await badgeIs(page, "Up to date");

      // Asset failures need a page whose worker holds C++ only: a 503 on a
      // generator is reported and retried, and cancelling while generators
      // download says so, restores the controls, and recovers on the next run.
      {
        const fresh = await browser.newPage();
        fresh.setDefaultTimeout(30_000);
        fresh.on("pageerror", (error) => errors.push(error.message));
        await fresh.goto(url);
        await badgeIs(fresh, "Up to date");
        let refused = 0;
        await fresh.route("**/capnpc-rust.wasm*", (route) => {
          refused++;
          return route.fulfill({ status: 503, body: "unavailable" });
        });
        await fresh.locator("#tab-rust").click();
        await badgeIs(fresh, "Generation failed");
        assert(
          refused === 1 &&
            (await fresh.locator("#diagnostics-error").innerText()).includes(
              "Could not load wasm/capnpc-rust.wasm (HTTP 503)",
            ) &&
            await fresh.locator("#output-files").isDisabled(),
          `${engine}: asset failure was not reported`,
        );
        await fresh.unroute("**/capnpc-rust.wasm*");
        await fresh.locator("#generate").click();
        await badgeIs(fresh, "Up to date");
        assert(
          await fresh.locator("#output-files").isEnabled(),
          `${engine}: retry after an asset failure did not recover`,
        );

        let releaseZig = () => {};
        const zigHeld = new Promise<void>((resolve) => releaseZig = resolve);
        await fresh.route("**/capnpc-zig.wasm*", async (route) => {
          await zigHeld;
          await route.continue().catch(() => {});
        });
        await fresh.locator("#generate-all").click();
        await fresh.waitForFunction(() =>
          document.querySelector("#status")?.textContent ===
            "Loading Go, Zig generators…"
        );
        await fresh.locator("#cancel").click();
        await fresh.waitForFunction(() =>
          document.querySelector("#status")?.textContent?.startsWith(
            "Cancelled",
          ) && document.body.dataset.busy === "false" &&
          document.querySelector<HTMLButtonElement>("#cancel")?.hidden === true
        );
        releaseZig();
        await fresh.unroute("**/capnpc-zig.wasm*");
        await generateAll(fresh);
        await fresh.locator("#tab-zig").click();
        assert(
          await fresh.locator("#output-files").isEnabled(),
          `${engine}: recovery after a cancelled download failed`,
        );
        await fresh.close();
      }

      // Real file-picker import, including binary bytes. The browser owns Files.
      await page.locator("#files-input").setInputFiles([
        {
          name: "imported.capnp",
          mimeType: "text/plain",
          buffer: Buffer.from(
            "@0xf8cd307a96412eb5; struct Imported { value @0 :Text; }",
          ),
        },
        {
          name: "asset.bin",
          mimeType: "application/octet-stream",
          buffer: Buffer.from([0, 255, 4, 128]),
        },
      ]);
      await page.locator("#confirm-action").click();
      await page.getByRole("button", { name: "Edit asset.bin", exact: true })
        .click();
      assert(
        await page.locator("#binary-preview").isVisible(),
        "Binary import opened as editable text",
      );
      const workspacePromise = page.waitForEvent("download");
      await page.locator("#download-workspace").click();
      await (await workspacePromise).saveAs(`${output}/workspace.zip`);
      const workspaceZip = await Deno.readFile(`${output}/workspace.zip`);
      const imported = unzipSync(workspaceZip);
      assert(
        imported["asset.bin"].join(",") === "0,255,4,128",
        "Workspace export changed binary bytes",
      );
      assert(
        decoder.decode(imported["imported.capnp"]).includes("struct Imported"),
        "Workspace export lost schema",
      );

      // The saved ZIP opens again through Import files.
      await page.locator("#examples").selectOption("telemetry");
      await page.locator("#confirm-action").click();
      await page.getByRole("button", {
        name: "Edit telemetry.capnp",
        exact: true,
      })
        .waitFor();
      await page.locator("#files-input").setInputFiles([{
        name: "schema-workspace.zip",
        mimeType: "application/zip",
        buffer: Buffer.from(workspaceZip),
      }]);
      await page.getByRole("button", {
        name: "Edit imported.capnp",
        exact: true,
      })
        .waitFor();
      assert(
        (await page.locator("#status").textContent())?.includes(
          "Imported 2 files from 1 archive",
        ),
        `${engine}: ZIP import was not reported`,
      );
      await page.getByRole("button", { name: "Edit asset.bin", exact: true })
        .click();
      assert(
        (await page.locator("#binary-preview").innerText()).includes(
          "00 ff 04 80",
        ),
        `${engine}: ZIP import changed binary bytes`,
      );
      await page.getByRole("button", {
        name: "Edit imported.capnp",
        exact: true,
      })
        .click();
      await page.locator("#generate").click();
      await badgeIs(page, "Up to date");

      // Directory uploads preserve relative imports and custom absolute embeds,
      // including names that are special on ordinary JavaScript objects, and
      // skip hidden entries such as .git and .DS_Store.
      const folder = `${root}/${output}/project`;
      await Deno.mkdir(`${folder}/types`, { recursive: true });
      await Deno.mkdir(`${folder}/include`, { recursive: true });
      await Deno.mkdir(`${folder}/.git/refs`, { recursive: true });
      await Deno.writeTextFile(
        `${folder}/main.capnp`,
        '@0xa53821f0bbcd907e; using Item = import "types/item.capnp"; const raw :Data = embed "/__proto__"; struct Root { item @0 :Item.Item; }',
      );
      await Deno.writeTextFile(
        `${folder}/types/item.capnp`,
        "@0xb49853dc62170aef; struct Item { label @0 :Text; }",
      );
      await Deno.writeFile(
        `${folder}/include/__proto__`,
        new Uint8Array([0, 255, 2, 128]),
      );
      await Deno.writeTextFile(`${folder}/.git/HEAD`, "ref: refs/heads/main\n");
      await Deno.writeTextFile(`${folder}/.git/refs/x`, "0\n");
      await Deno.writeFile(`${folder}/.DS_Store`, new Uint8Array([0, 0, 1]));
      await page.locator("#folder-input").setInputFiles(folder);
      // Engines differ in whether a picked folder includes hidden entries;
      // whatever the input received beyond the three visible files must be
      // skipped and counted.
      const delivered = await page.locator("#folder-input").evaluate((
        input,
      ) => (input as HTMLInputElement).files?.length ?? 0);
      const hiddenDelivered = delivered - 3;
      await page.locator("#confirm-action").click();
      await page.getByRole("button", {
        name: "Edit types/item.capnp",
        exact: true,
      }).waitFor();
      const importStatus = await page.locator("#status").textContent() ?? "";
      assert(
        hiddenDelivered >= 0 &&
          (hiddenDelivered === 0
            ? !importStatus.includes("skipped")
            : importStatus.includes(
              `skipped ${hiddenDelivered} hidden file`,
            )) &&
          await page.getByRole("button", { name: /Edit \.(git|DS_Store)/ })
              .count() === 0,
        `${engine}: hidden files were imported (${delivered} delivered): ${importStatus}`,
      );
      await page.locator("#generate").click();
      await badgeIs(page, "Up to date");
      assert(
        await page.locator("#output-files option").count() === 4,
        "Directory import did not generate both schemas",
      );
      await page.getByRole("checkbox", {
        name: "Generate types/item.capnp",
        exact: true,
      }).uncheck();
      assert(
        await page.locator("#download-all").isDisabled(),
        "Entrypoint edit left stale output",
      );
      await page.locator("#generate").click();
      await badgeIs(page, "Up to date");
      assert(
        await page.locator("#output-files option").count() === 2,
        "Unchecked import was still an entrypoint",
      );

      for (const example of ["telemetry", "service"]) {
        await page.locator("#examples").selectOption(example);
        if (await page.locator("#confirm-dialog").isVisible()) {
          await page.locator("#confirm-action").click();
        }
        await page.waitForFunction(
          (id) =>
            document.querySelector<HTMLSelectElement>("#examples")?.value ===
              id &&
            !document.querySelector<HTMLDialogElement>("#confirm-dialog")?.open,
          example,
        );
        await generateAll(page);
      }
      const workerRaces = await checkWorkerRaces(browser, url);

      // An engine without standardized exception handling gets a clear
      // unsupported state before any worker starts.
      const unsupported = await browser.newPage();
      await unsupported.addInitScript(() => {
        WebAssembly.validate = () => false;
        const RealWorker = globalThis.Worker;
        const counter = globalThis as { workersStarted?: number };
        counter.workersStarted = 0;
        globalThis.Worker = class extends RealWorker {
          constructor(...args: ConstructorParameters<typeof Worker>) {
            super(...args);
            counter.workersStarted!++;
          }
        };
      });
      await unsupported.goto(url);
      await unsupported.waitForFunction(() =>
        document.querySelector("#alert")?.textContent?.includes(
          "exception handling",
        )
      );
      const workersStarted = await unsupported.evaluate(() =>
        (globalThis as { workersStarted?: number }).workersStarted
      );
      assert(
        await unsupported.locator("#generate").getAttribute("aria-disabled") ===
            "true" &&
          workersStarted === 0 &&
          (await unsupported.locator("#status").textContent())?.startsWith(
            "Unsupported browser",
          ),
        `${engine}: unsupported-engine state missing`,
      );
      await unsupported.close();

      // The resize handle stores the split only; the sidebar follows the
      // stylesheet's breakpoints afterwards.
      const sidebarWidth = () =>
        page.locator(".workspace-panel").evaluate((element) =>
          element.getBoundingClientRect().width
        );
      const panelWidths = () =>
        page.evaluate(() => ({
          source:
            document.querySelector("#source-panel")!.getBoundingClientRect()
              .width,
          output:
            document.querySelector(".output-panel")!.getBoundingClientRect()
              .width,
        }));
      assert(await sidebarWidth() === 222, `${engine}: default sidebar width`);
      await page.locator("#resize").focus();
      await page.keyboard.press("ArrowRight");
      const widths = await panelWidths();
      assert(
        await page.locator("#resize").getAttribute("aria-valuenow") === "55" &&
          widths.source > widths.output,
        `${engine}: resize handle did not move the split ${
          JSON.stringify(widths)
        }`,
      );
      await page.setViewportSize({ width: 1000, height: 800 });
      assert(
        await sidebarWidth() === 185,
        `${engine}: resized sidebar ignored the narrow breakpoint`,
      );
      await page.setViewportSize({ width: 1700, height: 1000 });
      assert(
        await sidebarWidth() === 250,
        `${engine}: resized sidebar ignored the wide breakpoint`,
      );

      // Long filenames and 200% text scaling must not create page overflow,
      // and a phone-sized viewport shows the result after Generate.
      await page.setViewportSize({ width: 390, height: 844 });
      assert(
        await page.evaluate(() =>
          document.documentElement.scrollWidth <= innerWidth
        ),
        `${engine}: narrow viewport overflows`,
      );
      await page.evaluate(() => scrollTo(0, 0));
      await source.fill(`${presets[2].files["store.capnp"]}\n# Phone edit.\n`);
      await badgeIs(page, "Changes to generate");
      await page.locator("#generate").click();
      await badgeIs(page, "Up to date");
      await page.waitForFunction(() => {
        const panel = document.querySelector("#output-content")!
          .getBoundingClientRect();
        const status = document.querySelector(".status-bar")!
          .getBoundingClientRect();
        return panel.top >= -1 && panel.top < innerHeight / 2 &&
          status.bottom <= innerHeight + 1 && status.top >= 0;
      });
      await page.screenshot({ path: `${output}/mobile.png`, fullPage: true });
      const axeMobile = await scanAccessibility(page, output, "mobile");
      await page.evaluate(() =>
        document.documentElement.style.fontSize = "32px"
      );
      await page.screenshot({
        path: `${output}/large-text.png`,
        fullPage: true,
      });
      const overflow = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        elements: [...document.querySelectorAll("body *")].filter((element) =>
          element.getBoundingClientRect().right > innerWidth &&
          !element.closest(".cm-editor")
        ).map((element) => ({
          tag: element.tagName,
          id: element.id,
          cls: element.className,
          right: element.getBoundingClientRect().right,
        })),
      }));
      assert(
        overflow.scroll <= overflow.width,
        `${engine}: enlarged text overflows ${JSON.stringify(overflow)}`,
      );
      assert(
        errors.length === 0,
        `${engine} page errors: ${errors.join("; ")}`,
      );
      assert(
        requested.every((path) =>
          path.startsWith(url) || path.startsWith("blob:")
        ),
        "Studio requested a third-party resource",
      );
      await Deno.writeTextFile(
        `${output}/receipt.json`,
        JSON.stringify(
          {
            engine,
            expectedFiles: expected.size,
            workerRaces,
            axe: [axeInitial, axeOutput, axeMobile],
            headersChecked,
            pageErrors: errors,
            requested,
            passed: true,
          },
          null,
          2,
        ) + "\n",
      );
      console.log(
        `PASS ${engine}: Studio editing, four-language native parity, downloads, diagnostics, cancellation, keyboard flow, axe scans, imports, and responsive layout`,
      );
      await context.close();
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.shutdown();
}
console.log(`Studio evidence: ${evidence}`);
