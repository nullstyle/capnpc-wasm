// Run under an externally bounded process. Some Deno releases do not stop the
// worker and cannot exit this process normally. No SDK is involved. The
// optional argument chooses what the worker spins in: `js` (the default, an
// Atomics loop), `wasm`, or `wasm-catch-all` (the Wasm loop inside a
// try_table catch_all handler that retries). The output is one JSON line; the
// exit status is 1 when the counter still moved between three and four seconds
// after terminate().
import { spinGuest } from "./worker-termination-guest.ts";

const modes = ["js", "wasm", "wasm-catch-all"];
const mode = Deno.args[0] ?? "js";
if (!modes.includes(mode)) {
  throw new TypeError(`mode must be one of ${modes.join(", ")}: ${mode}`);
}
const worker = new Worker(
  new URL("./worker-termination-child.ts", import.meta.url),
  { type: "module" },
);
worker.onmessage = (event: MessageEvent<SharedArrayBuffer>) => {
  const counter = new Int32Array(event.data);
  const read = (index: number) => Atomics.load(counter, index) >>> 0;
  setTimeout(() => {
    worker.terminate();
    const atTermination = read(0);
    let afterThreeSeconds = 0;
    setTimeout(() => {
      afterThreeSeconds = read(0);
    }, 3000);
    setTimeout(() => {
      const afterFourSeconds = read(0);
      const continued = afterThreeSeconds !== afterFourSeconds;
      console.log(JSON.stringify({
        deno: Deno.version.deno,
        mode,
        atTermination,
        afterThreeSeconds,
        afterFourSeconds,
        continuedAfterThreeSeconds: continued,
        // Exceptions the catch_all handler caught (wasm-catch-all only).
        caught: read(1),
      }));
      Deno.exitCode = continued ? 1 : 0;
    }, 4000);
  }, 50);
};
worker.postMessage({ mode, guest: mode === "js" ? undefined : spinGuest });
