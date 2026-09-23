;; random_get sizes host work from the guest's length. Out-of-range fills must
;; return EINVAL without allocating; in-range fills happen in place, in 64 KiB
;; chunks, so a fill larger than one chunk must still succeed.
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "random_get"
    (func $random_get (param i32 i32) (result i32)))
  (memory (export "memory") 2)
  (data (i32.const 8) "\10\00\00\00\01\00\00\00")
  (func $report (param $errno i32)
    (i32.store8 (i32.const 16) (local.get $errno))
    (drop (call $fd_write
      (i32.const 1) (i32.const 8) (i32.const 1) (i32.const 24))))
  (func (export "_start")
    (call $report (call $random_get (i32.const 0) (i32.const 0x7fffffff)))
    (call $report (call $random_get (i32.const 0xffff0000) (i32.const 0x20000)))
    ;; 66048 bytes at 256 cross the host's chunk boundary within two pages.
    (call $report (call $random_get (i32.const 256) (i32.const 66048)))
    ;; Sixteen random bytes are all zero with negligible probability.
    (call $report (i32.and
      (i64.eqz (i64.load (i32.const 256)))
      (i64.eqz (i64.load (i32.const 66296)))))))
