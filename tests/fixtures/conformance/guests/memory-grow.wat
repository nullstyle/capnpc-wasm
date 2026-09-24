;; A generator that asks for 4,200 more pages from one: past the default
;; 4,096-page memoryPages ceiling and the launcher's 256 MiB bound. Exits 12
;; when the growth is refused and 0 when a host granted it.
(module
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (func (export "_start")
    (if (i32.eq (memory.grow (i32.const 4200)) (i32.const -1))
      (then (call $proc_exit (i32.const 12))))
    (call $proc_exit (i32.const 0))))
