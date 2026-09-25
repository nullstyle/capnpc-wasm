// Diagnostic worker: shared state exposes execution after terminate() returns.
// It spins in JavaScript (an Atomics loop), in Wasm, or in Wasm inside a
// catch_all handler, and first posts the shared buffer it counts in.
globalThis.onmessage = async (
  event: MessageEvent<{ mode: string; guest?: Uint8Array }>,
) => {
  const { mode, guest } = event.data;
  if (mode === "js") {
    const shared = new SharedArrayBuffer(8);
    const counter = new Int32Array(shared);
    postMessage(shared);
    while (true) Atomics.add(counter, 0, 1);
  }
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
    shared: true,
  });
  const { instance } = await WebAssembly.instantiate(guest!, {
    env: { memory },
  });
  const exports = instance.exports as {
    spin(): void;
    spin_catch_all(): void;
  };
  postMessage(memory.buffer);
  if (mode === "wasm") exports.spin();
  else exports.spin_catch_all();
};
