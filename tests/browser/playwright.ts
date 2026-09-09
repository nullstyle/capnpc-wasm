import fs from "node:fs";

async function load<T>(importPackage: () => Promise<T>): Promise<T> {
  // Playwright's optional WSL detection probes a privileged procfs path. Deno
  // correctly denies that check with these permissions. Treat only this
  // unavailable probe as false while importing; do not grant extra access.
  const original = fs.existsSync;
  fs.existsSync = (path) => {
    try {
      return original(path);
    } catch (error) {
      if (
        Deno.build.os === "linux" &&
        path === "/proc/sys/fs/binfmt_misc/WSLInterop" &&
        error instanceof Deno.errors.NotCapable
      ) return false;
      throw error;
    }
  };
  try {
    return await importPackage();
  } finally {
    fs.existsSync = original;
  }
}

export const { chromium, firefox, webkit } = await load(() =>
  import("playwright")
);

if (import.meta.main) {
  await load(() =>
    import(new URL("./cli.js", import.meta.resolve("playwright")).href)
  );
}
