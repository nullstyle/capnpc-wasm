;; poll_oneoff may be handed one buffer as both its subscription and its
;; event: the host must read the whole subscription before it writes the
;; event. The guest subscribes to a relative monotonic clock with no timeout
;; and userdata 42, and exits with the userdata the event reports.
(module
  (import "wasi_snapshot_preview1" "poll_oneoff"
    (func $poll_oneoff (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (func (export "_start")
    (i64.store (i32.const 0) (i64.const 42)) ;; userdata
    (i32.store8 (i32.const 8) (i32.const 0)) ;; EVENTTYPE_CLOCK
    (i32.store (i32.const 16) (i32.const 1)) ;; CLOCKID_MONOTONIC
    (i64.store (i32.const 24) (i64.const 0)) ;; timeout
    (i64.store (i32.const 32) (i64.const 0)) ;; precision
    (i32.store16 (i32.const 40) (i32.const 0)) ;; relative
    (drop
      (call $poll_oneoff
        (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 64)))
    (call $proc_exit (i32.wrap_i64 (i64.load (i32.const 0))))))
