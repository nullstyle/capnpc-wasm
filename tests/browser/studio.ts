/// <reference lib="dom" />
import { chromium, firefox, webkit } from "./playwright.ts";
import { selectedEngines } from "./engines.ts";
import { checkWorkerRaces } from "./studio-worker-races.js";
import { unzipSync } from "fflate";
import { Buffer } from "node:buffer";
import { serveStudio } from "../../scripts/serve-example.ts";
import { presets } from "../../examples/browser/presets.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const decoder = new TextDecoder();
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

const server = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen() {} },
  serveStudio,
);
const url = `http://127.0.0.1:${server.addr.port}/`;
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
      await page.waitForFunction(() =>
        document.querySelector("#output-badge")?.textContent === "Up to date"
      );
      assert(
        !requested.some((path) => /capnpc-(rust|go|zig)\.wasm/.test(path)),
        `${engine}: eagerly fetched unselected generators`,
      );
      assert(
        await page.getByRole("button", {
          name: "Edit types/common.capnp",
          exact: true,
        }).count() === 1,
        "Multi-file workspace missing",
      );
      await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });

      await page.locator("#generate-all").click();
      await page.waitForFunction(() =>
        !document.querySelector<HTMLButtonElement>("#generate")?.disabled &&
        document.querySelector("#status")?.textContent?.includes(
          "C++, Rust, Go, Zig",
        )
      );
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
      for (const language of ["rust", "go", "zig", "cpp"]) {
        await page.locator(`#tab-${language}`).click();
        assert(
          await page.locator("#output-files").isEnabled(),
          `${engine}: missing ${language} file browser`,
        );
      }
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

      await page.getByRole("button", {
        name: "Edit types/common.capnp",
        exact: true,
      }).click();
      const changed = presets[0].files["types/common.capnp"]!.replace(
        "online @2 :Bool = false;",
        "online @2 :Bool = false;\n  nickname @3 :Text;",
      );
      await page.getByRole("textbox", { name: "Schema source", exact: true })
        .fill(changed);
      await page.waitForFunction(() =>
        document.querySelector("#output-badge")?.textContent ===
          "Changes to generate"
      );
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
      await page.locator("#generate").click();
      await page.waitForFunction(() =>
        document.querySelector("#output-badge")?.textContent === "Up to date"
      );
      await page.locator("#output-files").selectOption("types/common.capnp.h");
      const changedPromise = page.waitForEvent("download");
      await page.locator("#download-file").click();
      await (await changedPromise).saveAs(`${output}/changed.h`);
      assert(
        (await Deno.readTextFile(`${output}/changed.h`)).includes("Nickname"),
        "Imported schema edit did not affect output",
      );

      await page.getByRole("textbox", { name: "Schema source", exact: true })
        .fill("this is not a schema");
      await page.locator("#generate").click();
      await page.waitForFunction(() =>
        document.querySelector("#output-badge")?.textContent ===
          "Generation failed"
      );
      assert(
        (await page.locator("#diagnostics-text").innerText()).includes(
          "common.capnp",
        ),
        "Compiler source diagnostics lost",
      );
      assert(
        await page.locator("#download-all").isDisabled(),
        "Failed compile exposed old output",
      );
      await page.getByRole("textbox", { name: "Schema source", exact: true })
        .fill(changed);
      await page.locator("#generate").click();
      await page.waitForFunction(() =>
        document.querySelector("#output-badge")?.textContent === "Up to date"
      );

      // Cancellation at the asset boundary must be recoverable without fetching
      // unrelated generators or allowing a late result to replace current state.
      await page.locator("#generate-all").click();
      await page.locator("#cancel").click();
      await page.waitForFunction(() =>
        !document.querySelector<HTMLButtonElement>("#generate")?.disabled
      );
      await page.locator("#generate").click();
      await page.waitForFunction(() =>
        document.querySelector("#output-badge")?.textContent === "Up to date"
      );

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
      const imported = unzipSync(
        await Deno.readFile(`${output}/workspace.zip`),
      );
      assert(
        imported["asset.bin"].join(",") === "0,255,4,128",
        "Workspace export changed binary bytes",
      );
      assert(
        decoder.decode(imported["imported.capnp"]).includes("struct Imported"),
        "Workspace export lost schema",
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
      await page.waitForFunction(() =>
        document.querySelector("#output-badge")?.textContent === "Up to date"
      );

      // Directory uploads preserve relative imports and custom absolute embeds,
      // including names that are special on ordinary JavaScript objects.
      const folder = `${root}/${output}/project`;
      await Deno.mkdir(`${folder}/types`, { recursive: true });
      await Deno.mkdir(`${folder}/include`, { recursive: true });
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
      await page.locator("#folder-input").setInputFiles(folder);
      await page.locator("#confirm-action").click();
      await page.getByRole("button", {
        name: "Edit types/item.capnp",
        exact: true,
      }).waitFor();
      await page.locator("#generate").click();
      await page.waitForFunction(() =>
        document.querySelector("#output-badge")?.textContent === "Up to date"
      );
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
      await page.waitForFunction(() =>
        document.querySelector("#output-badge")?.textContent === "Up to date"
      );
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
        await page.locator("#generate-all").click();
        await page.waitForFunction(() =>
          !document.querySelector<HTMLButtonElement>("#generate")?.disabled &&
          document.querySelector("#status")?.textContent?.includes(
            "C++, Rust, Go, Zig",
          )
        );
      }
      const workerRaces = await checkWorkerRaces(browser, url);

      // Long filenames and 200% text scaling must not create page overflow.
      await page.setViewportSize({ width: 390, height: 844 });
      assert(
        await page.evaluate(() =>
          document.documentElement.scrollWidth <= innerWidth
        ),
        `${engine}: narrow viewport overflows`,
      );
      await page.screenshot({ path: `${output}/mobile.png`, fullPage: true });
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
            pageErrors: errors,
            requested,
            passed: true,
          },
          null,
          2,
        ) + "\n",
      );
      console.log(
        `PASS ${engine}: Studio editing, four-language native parity, downloads, diagnostics, cancellation, imports, and responsive layout`,
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
