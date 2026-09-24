;; Writes "warning: kept" to stderr and exits 0: a successful stage's stderr
;; must be retained as a diagnostic.
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "\10\00\00\00\0e\00\00\00")
  (data (i32.const 16) "warning: kept\0a")
  (func (export "_start")
    (drop (call $fd_write (i32.const 2) (i32.const 0) (i32.const 1) (i32.const 8)))))
