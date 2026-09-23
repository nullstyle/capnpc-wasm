;; Imports that only copy existing host data still write at guest pointers.
;; Ranges outside memory must return EINVAL rather than trap; in-range calls
;; keep working.
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_readdir"
    (func $fd_readdir (param i32 i32 i32 i64 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_prestat_dir_name"
    (func $fd_prestat_dir_name (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "poll_oneoff"
    (func $poll_oneoff (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 8) "\10\00\00\00\01\00\00\00")
  (func $report (param $errno i32)
    (i32.store8 (i32.const 16) (local.get $errno))
    (drop (call $fd_write
      (i32.const 1) (i32.const 8) (i32.const 1) (i32.const 24))))
  (func (export "_start")
    (call $report (call $fd_readdir
      (i32.const 3) (i32.const 0xffff0000) (i32.const 0x20000) (i64.const 0)
      (i32.const 24)))
    (call $report (call $fd_prestat_dir_name
      (i32.const 3) (i32.const 0xffffff00) (i32.const 0x1000)))
    (call $report (call $poll_oneoff
      (i32.const 0xffffff00) (i32.const 0) (i32.const 1) (i32.const 24)))
    ;; In range: list the root into 256 bytes, then copy the one-byte prestat name.
    (call $report (call $fd_readdir
      (i32.const 3) (i32.const 256) (i32.const 256) (i64.const 0)
      (i32.const 24)))
    (call $report (call $fd_prestat_dir_name
      (i32.const 3) (i32.const 512) (i32.const 1)))))
