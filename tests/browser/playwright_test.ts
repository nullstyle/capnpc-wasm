import fs from "node:fs";

Deno.test("Playwright bootstrap preserves filesystem permissions and functions", async () => {
  const original = fs.existsSync;
  const { chromium, firefox, webkit } = await import("./playwright.ts");
  if (fs.existsSync !== original) {
    throw new Error("Playwright bootstrap did not restore fs.existsSync");
  }
  for (const engine of [chromium, firefox, webkit]) {
    if (!engine.executablePath()) {
      throw new Error("missing browser executable path");
    }
  }
  if (!fs.existsSync(new URL(import.meta.url))) {
    throw new Error("ordinary filesystem checks changed after bootstrap");
  }
  if (Deno.build.os === "linux") {
    let blocked = false;
    try {
      fs.existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotCapable)) throw error;
      blocked = true;
    }
    if (!blocked) {
      throw new Error("privileged procfs access remained available");
    }
  }
});
