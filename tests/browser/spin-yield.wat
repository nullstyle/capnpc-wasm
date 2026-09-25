;; A WASI command that never returns and calls sched_yield on every
;; iteration. The termination acceptance submits it as the compiler of its
;; host-calling guest, whose sched_yield calls the probe counts (the pure-Wasm
;; guest is spin-counter.wat), and the recovery soak uses it as a zig generator
;; that keeps every cancelled job running.
(module
  (import "wasi_snapshot_preview1" "sched_yield" (func $yield (result i32)))
  (memory (export "memory") 1)
  (func (export "_start")
    (loop $spin
      (drop (call $yield))
      (br $spin))))
