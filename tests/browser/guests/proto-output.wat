;; Generated file names are guest-chosen. A file named "__proto__" must arrive
;; as an own property of a plain result object in both execution modes, next
;; to an ordinary file "a".
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close"
    (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 32) "__proto__")
  (data (i32.const 48) "a")
  (data (i32.const 64) "\50\00\00\00\01\00\00\00")
  (func $create (param $path i32) (param $length i32) (param $byte i32)
    (drop (call $path_open
      (i32.const 3) (i32.const 0) (local.get $path) (local.get $length)
      (i32.const 1) (i64.const 64) (i64.const 0) (i32.const 0) (i32.const 128)))
    (i32.store8 (i32.const 80) (local.get $byte))
    (drop (call $fd_write
      (i32.load (i32.const 128)) (i32.const 64) (i32.const 1) (i32.const 24)))
    (drop (call $fd_close (i32.load (i32.const 128)))))
  (func (export "_start")
    (call $create (i32.const 32) (i32.const 9) (i32.const 120))
    (call $create (i32.const 48) (i32.const 1) (i32.const 121))))
