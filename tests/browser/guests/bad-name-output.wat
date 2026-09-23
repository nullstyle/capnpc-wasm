;; Backslashes pass the shim's path parser but are not portable output names.
;; Output collection must reject the job instead of publishing the file.
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 32) "a\\b")
  (data (i32.const 64) "\50\00\00\00\01\00\00\00x")
  (func (export "_start")
    (drop (call $path_open
      (i32.const 3) (i32.const 0) (i32.const 32) (i32.const 3) (i32.const 1)
      (i64.const 64) (i64.const 0) (i32.const 0) (i32.const 128)))
    (drop (call $fd_write
      (i32.load (i32.const 128)) (i32.const 64) (i32.const 1) (i32.const 24)))))
