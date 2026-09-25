/**
 * The Wasm guests of the worker termination probe: `spin` increments the first
 * word of an imported shared page forever; `spin_catch_all` runs the same loop
 * inside `try_table (catch_all)` and counts caught exceptions in the second
 * word before it retries, as C++ `catch (...) { retry; }` would. A runtime that
 * stops JavaScript but lets Wasm (or a Wasm exception handler) keep running is
 * visible only with these guests.
 *
 * The bytes are the source below assembled with the pinned wasm-tools
 * (`parse`, then `strip --all`). The probe runs with read access to this
 * directory only, so it cannot assemble the source itself;
 * worker-termination-guest_test.ts reassembles it and fails on drift.
 */
export const spinGuestSource = `(module
  (import "env" "memory" (memory 1 1 shared))
  (func $spin
    (loop $again
      (drop (i32.atomic.rmw.add (i32.const 0) (i32.const 1)))
      (br $again)))
  (func (export "spin") (call $spin))
  (func (export "spin_catch_all")
    (loop $retry
      (block $caught
        (try_table (catch_all $caught) (call $spin)))
      (drop (i32.atomic.rmw.add (i32.const 4) (i32.const 1)))
      (br $retry))))
`;

export const spinGuest = Uint8Array.from(
  (
    "0061736d0100000001040160000002100103656e76066d656d6f72790203010103040300" +
    "0000071902047370696e00010e7370696e5f63617463685f616c6c00020a330310000340" +
    "41004101fe1e02001a0c000b0b040010000b1b00034002401f4001020010000b0b410441" +
    "01fe1e02001a0c000b0b"
  ).match(/../g)!,
  (byte) => parseInt(byte, 16),
);
