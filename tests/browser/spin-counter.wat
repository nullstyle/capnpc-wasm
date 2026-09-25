;; The termination probe's pure-Wasm guest, submitted as the job's compiler:
;; a loop that never calls an import, like a guest stuck computing. Only the
;; SDK's injected interruption checks leave Wasm, and the probe counts their
;; polls of capnp_wasm.interrupt.
(module
  (memory (export "memory") 1)
  (func (export "_start")
    (loop $spin
      (br $spin))))
