;; The compiler's workspace is read-only. Every mutation must fail with EROFS,
;; or with EPERM/EBADF where the shim itself refuses, leaving the snapshot
;; intact. The workspace holds one file, src/a.
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_pwrite"
    (func $fd_pwrite (param i32 i32 i32 i64 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_create_directory"
    (func $path_create_directory (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_unlink_file"
    (func $path_unlink_file (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_rename"
    (func $path_rename (param i32 i32 i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_remove_directory"
    (func $path_remove_directory (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_link"
    (func $path_link (param i32 i32 i32 i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_symlink"
    (func $path_symlink (param i32 i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_filestat_set_times"
    (func $path_filestat_set_times (param i32 i32 i32 i32 i64 i64 i32)
      (result i32)))
  (import "wasi_snapshot_preview1" "fd_allocate"
    (func $fd_allocate (param i32 i64 i64) (result i32)))
  (import "wasi_snapshot_preview1" "fd_filestat_set_size"
    (func $fd_filestat_set_size (param i32 i64) (result i32)))
  (import "wasi_snapshot_preview1" "fd_filestat_set_times"
    (func $fd_filestat_set_times (param i32 i64 i64 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 8) "\10\00\00\00\01\00\00\00")
  (data (i32.const 32) "src/a")
  (data (i32.const 40) "src/d")
  (data (i32.const 48) "src/b")
  (data (i32.const 56) "src")
  (data (i32.const 64) "a")
  (data (i32.const 72) "src/l")
  (data (i32.const 136) "\90\00\00\00\01\00\00\00y")
  (func $report (param $errno i32)
    (i32.store8 (i32.const 16) (local.get $errno))
    (drop (call $fd_write
      (i32.const 1) (i32.const 8) (i32.const 1) (i32.const 24))))
  (func (export "_start") (local $fd i32)
    ;; O_CREAT, O_TRUNC, then write rights on the existing file
    (call $report (call $path_open
      (i32.const 3) (i32.const 0) (i32.const 32) (i32.const 5) (i32.const 1)
      (i64.const 0) (i64.const 0) (i32.const 0) (i32.const 128)))
    (call $report (call $path_open
      (i32.const 3) (i32.const 0) (i32.const 32) (i32.const 5) (i32.const 8)
      (i64.const 0) (i64.const 0) (i32.const 0) (i32.const 128)))
    (call $report (call $path_open
      (i32.const 3) (i32.const 0) (i32.const 32) (i32.const 5) (i32.const 0)
      (i64.const 64) (i64.const 0) (i32.const 0) (i32.const 128)))
    (call $report (call $path_create_directory
      (i32.const 3) (i32.const 40) (i32.const 5)))
    (call $report (call $path_unlink_file
      (i32.const 3) (i32.const 32) (i32.const 5)))
    (call $report (call $path_rename
      (i32.const 3) (i32.const 32) (i32.const 5) (i32.const 3) (i32.const 48)
      (i32.const 5)))
    (call $report (call $path_remove_directory
      (i32.const 3) (i32.const 56) (i32.const 3)))
    (call $report (call $path_link
      (i32.const 3) (i32.const 0) (i32.const 32) (i32.const 5) (i32.const 3)
      (i32.const 48) (i32.const 5)))
    (call $report (call $path_symlink
      (i32.const 64) (i32.const 1) (i32.const 3) (i32.const 72) (i32.const 5)))
    (call $report (call $path_filestat_set_times
      (i32.const 3) (i32.const 0) (i32.const 32) (i32.const 5) (i64.const 0)
      (i64.const 0) (i32.const 0)))
    ;; A read-only open succeeds; descriptor mutations still fail.
    (call $report (call $path_open
      (i32.const 3) (i32.const 0) (i32.const 32) (i32.const 5) (i32.const 0)
      (i64.const 2) (i64.const 0) (i32.const 0) (i32.const 128)))
    (local.set $fd (i32.load (i32.const 128)))
    (call $report (call $fd_allocate
      (local.get $fd) (i64.const 0) (i64.const 1)))
    (call $report (call $fd_filestat_set_size (local.get $fd) (i64.const 0)))
    (call $report (call $fd_filestat_set_times
      (local.get $fd) (i64.const 0) (i64.const 0) (i32.const 0)))
    (call $report (call $fd_write
      (local.get $fd) (i32.const 136) (i32.const 1) (i32.const 24)))
    (call $report (call $fd_pwrite
      (local.get $fd) (i32.const 136) (i32.const 1) (i64.const 0)
      (i32.const 24)))))
