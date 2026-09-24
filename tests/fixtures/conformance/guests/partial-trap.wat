;; Like partial-exit, but the generator traps (unreachable) instead of exiting:
;; the partial file and the stderr text must still be handled the same way.
(module
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close" (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "partial.txt")
  (data (i32.const 16) "\20\00\00\00\05\00\00\00")
  (data (i32.const 32) "hello")
  (data (i32.const 64) "\50\00\00\00\0e\00\00\00")
  (data (i32.const 80) "failed midway\0a")
  (func (export "_start")
    (local $fd i32)
    (if (call $path_open (i32.const 3) (i32.const 0) (i32.const 0) (i32.const 11)
          (i32.const 9) (i64.const 0x1fffffff) (i64.const 0x1fffffff) (i32.const 0)
          (i32.const 48))
      (then (call $proc_exit (i32.const 70))))
    (local.set $fd (i32.load (i32.const 48)))
    (drop (call $fd_write (local.get $fd) (i32.const 16) (i32.const 1) (i32.const 52)))
    (drop (call $fd_close (local.get $fd)))
    (drop (call $fd_write (i32.const 2) (i32.const 64) (i32.const 1) (i32.const 52)))
    unreachable))
