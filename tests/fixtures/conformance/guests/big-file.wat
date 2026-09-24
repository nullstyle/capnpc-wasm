;; A generator that writes one 65 MiB file (65 writes of one 1 MiB buffer), one
;; MiB over the default outputBytes budget. Exits 100 plus the errno of a
;; failed write, so a host that fails the write is classified by the budget.
(module
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 17)
  (data (i32.const 0) "big.bin")
  (data (i32.const 16) "\00\00\01\00\00\00\10\00")
  (func (export "_start")
    (local $i i32) (local $fd i32) (local $err i32)
    (if (call $path_open (i32.const 3) (i32.const 0) (i32.const 0) (i32.const 7)
          (i32.const 9) (i64.const 0x1fffffff) (i64.const 0x1fffffff) (i32.const 0)
          (i32.const 48))
      (then (call $proc_exit (i32.const 70))))
    (local.set $fd (i32.load (i32.const 48)))
    (block $done (loop $l
      (br_if $done (i32.ge_u (local.get $i) (i32.const 65)))
      (local.set $err (call $fd_write (local.get $fd) (i32.const 16) (i32.const 1) (i32.const 52)))
      (if (local.get $err)
        (then (call $proc_exit (i32.add (i32.const 100) (local.get $err)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (call $proc_exit (i32.const 0))))
