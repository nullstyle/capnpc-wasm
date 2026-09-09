;; A one-page command tries to grow twice and writes its final memory size.
;; A two-page SDK ceiling must make the second growth fail in every engine.
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "\08\00\00\00\01\00\00\00")
  (func (export "_start")
    (drop (memory.grow (i32.const 1)))
    (drop (memory.grow (i32.const 1)))
    (i32.store8 (i32.const 8) (memory.size))
    (drop (call $fd_write
      (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 12)))))
