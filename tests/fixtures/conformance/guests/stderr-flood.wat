;; A command that writes 2 MiB of 'E' to stderr (32 writes of a 64 KiB page),
;; twice the default stderrBytes budget, then exits 0. Exits 71 if a write
;; fails.
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 2)
  (data (i32.const 0) "\00\00\01\00\00\00\01\00")
  (func (export "_start")
    (local $i i32)
    (memory.fill (i32.const 65536) (i32.const 69) (i32.const 65536))
    (block $done (loop $l
      (br_if $done (i32.ge_u (local.get $i) (i32.const 32)))
      (if (call $fd_write (i32.const 2) (i32.const 0) (i32.const 1) (i32.const 8))
        (then (call $proc_exit (i32.const 71))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (call $proc_exit (i32.const 0))))
