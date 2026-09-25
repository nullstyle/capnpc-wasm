;; A guest with no imports that spins inside a handler catching every
;; exception, then returns normally. If a failure while polling the job
;; reached the guest as a JavaScript exception, this handler would catch it
;; and the job would exit 0; the host must stop it with a trap instead.
(module
  (memory (export "memory") 1)
  (func (export "_start")
    (block $caught
      (try_table (catch_all $caught)
        (loop $spin (br $spin))))))
