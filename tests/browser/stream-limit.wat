;; Repeated small writes reach the shim's in-place ArrayBuffer growth path.
;; A six-byte stdout limit must reject the seventh write before it is retained.
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "\08\00\00\00\01\00\00\00x")
  (func (export "_start") (local $count i32)
    (loop $write
      (drop (call $fd_write
        (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 12)))
      (local.set $count (i32.add (local.get $count) (i32.const 1)))
      (br_if $write (i32.lt_u (local.get $count) (i32.const 7))))))
