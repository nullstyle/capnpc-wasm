;; Every path_open keeps a host descriptor object alive until fd_close. A guest
;; that never closes must hit the SDK's descriptor cap (ENFILE) instead of
;; growing host memory with its CPU time. Reports the errno, then the count of
;; successful opens as two little-endian bytes.
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 8) "\10\00\00\00\03\00\00\00")
  (data (i32.const 32) "src")
  (func (export "_start") (local $count i32) (local $ret i32)
    (block $done
      (loop $again
        (local.set $ret (call $path_open
          (i32.const 3) (i32.const 0) (i32.const 32) (i32.const 3) (i32.const 0)
          (i64.const 0) (i64.const 0) (i32.const 0) (i32.const 40)))
        (br_if $done (local.get $ret))
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        (br_if $again (i32.lt_u (local.get $count) (i32.const 4096)))))
    (i32.store8 (i32.const 16) (local.get $ret))
    (i32.store16 (i32.const 17) (local.get $count))
    (drop (call $fd_write
      (i32.const 1) (i32.const 8) (i32.const 1) (i32.const 24)))))
