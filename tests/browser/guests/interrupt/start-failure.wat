;; A start function runs during instantiation, before the host can zero the
;; countdown. This one calls fd_write, which fails in the host because the
;; shim has no instance yet; the host records the failure, and _start, which
;; would exit 0, must not turn the job into a success.
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (func $early
    (drop
      (call $fd_write (i32.const 1) (i32.const 0) (i32.const 0) (i32.const 0))))
  (start $early)
  (func (export "_start")
    (call $proc_exit (i32.const 0))))
