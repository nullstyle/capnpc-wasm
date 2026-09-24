;; A generator that publishes an output whose 17-byte name exceeds a 16-byte
;; pathBytes budget. The file itself is one byte. Exits 70 if the host refuses
;; the open, so a host that rejects the name at creation is still classified by
;; the budget, not by this status.
(module
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "abcdefghijklmnopq")
  (func (export "_start")
    (if (call $path_open (i32.const 3) (i32.const 0) (i32.const 0) (i32.const 17)
          (i32.const 9) (i64.const 0x1fffffff) (i64.const 0x1fffffff) (i32.const 0)
          (i32.const 48))
      (then (call $proc_exit (i32.const 70))))
    (call $proc_exit (i32.const 0))))
