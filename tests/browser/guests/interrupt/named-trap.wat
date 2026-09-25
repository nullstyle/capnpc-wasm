;; Instrumentation shifts every defined function index by one, so the name
;; section has to shift with it: a trap backtrace from the instrumented guest
;; must still name $bravo, called from $charlie. Assembled without strip so
;; the name section (function and local names, no labels) stays.
(module
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (func $alpha (result i32) (i32.const 1))
  (func $bravo (local $scratch i32)
    (local.set $scratch (call $alpha))
    (unreachable))
  (func $charlie (call $bravo))
  (func (export "_start") (call $charlie)))
