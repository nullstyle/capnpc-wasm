// Diagnostic worker: shared state exposes execution after terminate() returns.
globalThis.onmessage = (event: MessageEvent<SharedArrayBuffer>) => {
  const counter = new Int32Array(event.data);
  postMessage("ready");
  while (true) Atomics.add(counter, 0, 1);
};
