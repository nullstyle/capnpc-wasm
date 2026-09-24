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
        holdInit: true,
        heldInits: 0,
        releaseInit: null,
        holdCompile: false,
        pending: null,
      };
      globalThis.Worker = class extends RealWorker {
        constructor(...args) {
          super(...args);
          audit.created++;
          this.stopped = false;
        }
        postMessage(message, ...args) {
          const post = () =>
            RealWorker.prototype.postMessage.call(this, message, ...args);
          if (audit.holdInit && message.kind === "init") {
            // The worker never learns its modules until released, so the
            // client stays in its starting state.
            audit.heldInits++;
            audit.releaseInit = post;
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
    const snapshot = () =>
      page.evaluate(() => ({
        created: globalThis.studioAudit.created,
        terminated: globalThis.studioAudit.terminated,
        heldInits: globalThis.studioAudit.heldInits,
      }));
    await page.goto(url);
    await page.waitForFunction(() => globalThis.studioAudit.heldInits === 1);
    // Cancelling a starting worker terminates it inside the SDK: after every
    // cancellation no worker is alive, and the next Generate starts one.
    for (let i = 0; i < 5; i++) {
      await page.locator("#cancel").click();
      await page.waitForFunction(() =>
        document.querySelector("#status").textContent.startsWith("Cancelled") &&
        document.body.dataset.busy === "false"
      );
      const audit = await snapshot();
      if (audit.created !== i + 1 || audit.terminated !== audit.created) {
        throw new Error(
          `Cancelled initialization left a worker alive: ${
            JSON.stringify(audit)
          }`,
        );
      }
      await page.locator("#generate").click();
      await page.waitForFunction(
        (count) => globalThis.studioAudit.heldInits === count,
        i + 2,
      );
    }
    await page.evaluate(() => {
      globalThis.studioAudit.holdInit = false;
      globalThis.studioAudit.releaseInit();
    });
    await page.waitForFunction(() =>
      document.querySelector("#output-badge").textContent === "Up to date"
    );
    const started = await snapshot();
    if (started.created !== 6 || started.terminated !== 5) {
      throw new Error(
        `Initialization cleanup failed: ${JSON.stringify(started)}`,
      );
    }

    // Edits during a run offer a restart, and a job that finishes for an old
    // snapshot, successfully or not, never touches the current workspace.
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
      await page.waitForFunction(() =>
        document.querySelector("#status").textContent ===
          "Workspace changed. Generate to restart with the latest edits." &&
        document.querySelector("#generate").getAttribute("aria-disabled") ===
          "false"
      );
      await page.evaluate(() => globalThis.studioAudit.pending());
      await page.waitForFunction(() => document.body.dataset.busy === "false");
      const state = await page.evaluate(() => ({
        badge: document.querySelector("#output-badge").textContent,
        diagnostics: document.querySelector("#diagnostics-text").textContent,
        disabled: document.querySelector("#download-all").disabled,
        status: document.querySelector("#status").textContent,
      }));
      if (
        state.badge !== "Changes to generate" ||
        state.diagnostics !== "No diagnostics." || !state.disabled ||
        !state.status.startsWith("Workspace changed during generation")
      ) {
        throw new Error(
          `Old snapshot changed the current workspace: ${
            JSON.stringify(state)
          }`,
        );
      }
    }

    // Generate during a stale run stops the obsolete job (its worker is
    // terminated) and starts over with the latest edits.
    await page.evaluate(() => globalThis.studioAudit.holdCompile = true);
    await page.locator("#generate").click();
    await page.waitForFunction(() => globalThis.studioAudit.pending !== null);
    const beforeRestart = await snapshot();
    await source.fill(`${valid}\n# Restarted with the latest edits.\n`);
    await page.evaluate(() => {
      globalThis.studioAudit.holdCompile = false;
      globalThis.studioAudit.pending = null;
    });
    await page.locator("#generate").click();
    await page.waitForFunction(() =>
      document.querySelector("#output-badge").textContent === "Up to date"
    );
    const afterRestart = await snapshot();
    if (
      afterRestart.terminated !== beforeRestart.terminated + 1 ||
      afterRestart.created !== beforeRestart.created + 1
    ) {
      throw new Error(
        `Restart did not replace the obsolete job's worker: ${
          JSON.stringify({ beforeRestart, afterRestart })
        }`,
      );
    }
    const restartedStatus = await page.locator("#status").textContent();
    if (!restartedStatus.startsWith("Generated ")) {
      throw new Error(`Restart did not report its result: ${restartedStatus}`);
    }
    if (errors.length) throw new Error(errors.join("\n"));
    return {
      cancellations: 5,
      created: afterRestart.created,
      terminated: afterRestart.terminated,
      staleSuccessDiscarded: true,
      staleFailureDiscarded: true,
      restartedDuringRun: true,
      pageErrors: errors,
    };
  } finally {
    await page.close();
  }
}
