;; The termination probe's host-calling guest and the module every
;; termination job submits: a compiler that never returns and calls WASI
;; sched_yield on every iteration. The probe counts those calls in shared
;; memory; for the pure-Wasm guest it instantiates spin-counter.wat instead.
(module
  (import "wasi_snapshot_preview1" "sched_yield" (func $yield (result i32)))
  (memory (export "memory") 1)
  (func (export "_start")
    (loop $spin
      (drop (call $yield))
      (br $spin))))
