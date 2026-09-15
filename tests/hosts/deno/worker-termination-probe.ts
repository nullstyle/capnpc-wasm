// Run under an externally bounded process. Some Deno releases do not stop the
// worker and cannot exit this process normally. No SDK or WebAssembly is involved.
const shared = new SharedArrayBuffer(4);
const counter = new Int32Array(shared);
const worker = new Worker(
  new URL("./worker-termination-child.ts", import.meta.url),
  { type: "module" },
);
worker.onmessage = () => {
  setTimeout(() => {
    worker.terminate();
    const atTermination = Atomics.load(counter, 0);
    let afterThreeSeconds = 0;
    setTimeout(() => {
      afterThreeSeconds = Atomics.load(counter, 0);
    }, 3000);
    setTimeout(() => {
      const afterFourSeconds = Atomics.load(counter, 0);
      const continued = afterThreeSeconds !== afterFourSeconds;
      console.log(JSON.stringify({
        deno: Deno.version.deno,
        atTermination,
        afterThreeSeconds,
        afterFourSeconds,
        continuedAfterThreeSeconds: continued,
      }));
      Deno.exitCode = continued ? 1 : 0;
    }, 4000);
  }, 50);
};
worker.postMessage(shared);
