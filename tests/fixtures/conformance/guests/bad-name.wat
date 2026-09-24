;; A generator that publishes an output named "a\b". Backslashes pass the
;; shim's path parser but are not portable names: the SDKs must reject the job
;; instead of publishing the file. Exits 70 if the host refuses the open.
(module
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "a\5cb")
  (func (export "_start")
    (if (call $path_open (i32.const 3) (i32.const 0) (i32.const 0) (i32.const 3)
          (i32.const 9) (i64.const 0x1fffffff) (i64.const 0x1fffffff) (i32.const 0)
          (i32.const 48))
      (then (call $proc_exit (i32.const 70))))
    (call $proc_exit (i32.const 0))))
