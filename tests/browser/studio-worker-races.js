import { presets } from "../../examples/browser/presets.js";

// Delay real worker messages, never compiler results. The released operation
// still executes the shipped Wasm modules and exercises SDK cancellation.
export async function checkWorkerRaces(browser, url) {
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.addInitScript(() => {
      const RealWorker = globalThis.Worker;
      const audit = globalThis.studioAudit = {
        created: 0,
        terminated: 0,
        held: false,
        holdCompile: false,
        pending: null,
      };
      globalThis.Worker = class extends RealWorker {
        constructor(...args) {
          super(...args);
          this.index = ++audit.created;
          this.stopped = false;
        }
        postMessage(message, ...args) {
          const post = () =>
            RealWorker.prototype.postMessage.call(this, message, ...args);
          if (this.index === 1 && message.kind === "init") {
            audit.held = true;
            globalThis.releaseStudioInit = () => {
              audit.held = false;
              post();
            };
          } else if (audit.holdCompile && message.kind === "compile") {
            audit.pending = () => {
              audit.pending = null;
              audit.holdCompile = false;
              post();
            };
          } else post();
        }
        terminate() {
          if (!this.stopped) {
            audit.terminated++;
            this.stopped = true;
          }
          super.terminate();
        }
      };
    });
    await page.goto(url);
    await page.waitForFunction(() => globalThis.studioAudit.held);
    for (let i = 0; i < 5; i++) {
      await page.locator("#cancel").click();
      await page.waitForFunction(() =>
        !document.querySelector("#generate").disabled
      );
      const created = await page.evaluate(() => globalThis.studioAudit.created);
      if (created !== 1) {
        throw new Error(
          `Cancelled initialization accumulated ${created} workers`,
        );
      }
      await page.locator("#generate").click();
    }
    await page.evaluate(() => globalThis.releaseStudioInit());
    await page.waitForFunction(() =>
      document.querySelector("#output-badge").textContent === "Up to date"
    );
    const audit = await page.evaluate(() => ({
      created: globalThis.studioAudit.created,
      terminated: globalThis.studioAudit.terminated,
    }));
    if (audit.created !== 3 || audit.terminated !== 1) {
      throw new Error(
        `Initialization cleanup failed: ${JSON.stringify(audit)}`,
      );
    }

    const source = page.getByRole("textbox", {
      name: "Schema source",
      exact: true,
    });
    const valid = presets[0].files["chat.capnp"];
    for (const initial of ["invalid schema", valid]) {
      await source.fill(initial);
      await page.evaluate(() => globalThis.studioAudit.holdCompile = true);
      await page.locator("#generate").click();
      await page.waitForFunction(() => globalThis.studioAudit.pending !== null);
      await source.fill(`${valid}\n# Edited while compiling.\n`);
      await page.evaluate(() => globalThis.studioAudit.pending());
      await page.waitForFunction(() =>
        !document.querySelector("#generate").disabled
      );
      const state = await page.evaluate(() => ({
        badge: document.querySelector("#output-badge").textContent,
        diagnostics: document.querySelector("#diagnostics-text").textContent,
        disabled: document.querySelector("#download-all").disabled,
      }));
      if (
        state.badge !== "Changes to generate" ||
        state.diagnostics !== "No diagnostics." || !state.disabled
      ) {
        throw new Error(
          `Old snapshot changed the current workspace: ${
            JSON.stringify(state)
          }`,
        );
      }
    }
    await page.locator("#generate").click();
    await page.waitForFunction(() =>
      document.querySelector("#output-badge").textContent === "Up to date"
    );
    if (errors.length) throw new Error(errors.join("\n"));
    return {
      cancellations: 5,
      created: audit.created,
      terminated: audit.terminated,
      staleSuccessDiscarded: true,
      staleFailureDiscarded: true,
      pageErrors: errors,
    };
  } finally {
    await page.close();
  }
}
