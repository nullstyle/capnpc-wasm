;; The termination probe's pure-Wasm guest. The probe worker instantiates it
;; in place of the job's module: it imports one shared page, exports it as the
;; guest's memory, and increments the page's first word in a loop that never
;; leaves Wasm, so only an engine that interrupts Wasm itself can stop it.
(module
  (import "env" "memory" (memory 1 1 shared))
  (export "memory" (memory 0))
  (func (export "_start")
    (loop $again
      (drop (i32.atomic.rmw.add (i32.const 0) (i32.const 1)))
      (br $again))))
