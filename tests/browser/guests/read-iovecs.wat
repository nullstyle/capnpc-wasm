;; Read-side iovec arrays are sized by the guest. A one-page guest asking for
;; 0x7fffffff iovecs, or naming a buffer outside memory, must get EINVAL back
;; before the host allocates anything. Each errno is reported as one stdout byte.
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read"
    (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_pread"
    (func $fd_pread (param i32 i32 i32 i64 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 8) "\10\00\00\00\01\00\00\00")
  (func $report (param $errno i32)
    (i32.store8 (i32.const 16) (local.get $errno))
    (drop (call $fd_write
      (i32.const 1) (i32.const 8) (i32.const 1) (i32.const 24))))
  (func (export "_start")
    ;; 0x7fffffff iovecs starting at address 0 cannot fit in one page.
    (call $report (call $fd_read
      (i32.const 0) (i32.const 0) (i32.const 0x7fffffff) (i32.const 24)))
    (call $report (call $fd_pread
      (i32.const 0) (i32.const 0) (i32.const 0x7fffffff) (i64.const 0)
      (i32.const 24)))
    ;; One iovec whose buffer lies outside memory.
    (i32.store (i32.const 0) (i32.const 0xfffff000))
    (i32.store (i32.const 4) (i32.const 16))
    (call $report (call $fd_read
      (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 24)))
    (call $report (call $fd_pread
      (i32.const 0) (i32.const 0) (i32.const 1) (i64.const 0) (i32.const 24)))
    ;; A valid read of the empty stdin succeeds with nothing read.
    (i32.store (i32.const 0) (i32.const 32))
    (i32.store (i32.const 4) (i32.const 8))
    (call $report (call $fd_read
      (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 24)))))
