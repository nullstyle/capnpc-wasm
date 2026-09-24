;; The shim retains a new descriptor before it writes the fd number. With the
;; result pointer outside memory that write would throw after the push, and a
;; guest that catches the exception with catch_all could keep opening past the
;; descriptor cap. The SDK must reject the pointer with EINVAL before the shim
;; runs. Reports: the errno, EINVAL count, caught-exception count, and the fd
;; number a later valid open receives (4 when nothing leaked).
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 8) "\10\00\00\00\07\00\00\00")
  (data (i32.const 32) "src")
  (func (export "_start")
    (local $i i32) (local $ret i32) (local $einval i32) (local $caught i32)
    (loop $again
      (block $handled
        (block $thrown
          (try_table (catch_all $thrown)
            (local.set $ret (call $path_open
              (i32.const 3) (i32.const 0) (i32.const 32) (i32.const 3)
              (i32.const 0) (i64.const 0) (i64.const 0) (i32.const 0)
              (i32.const 65536))))
          (if (i32.eq (local.get $ret) (i32.const 28))
            (then (local.set $einval (i32.add (local.get $einval) (i32.const 1)))))
          (br $handled))
        (local.set $caught (i32.add (local.get $caught) (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $again (i32.lt_u (local.get $i) (i32.const 2000))))
    ;; A valid open with an in-range result pointer shows whether the table grew.
    (drop (call $path_open
      (i32.const 3) (i32.const 0) (i32.const 32) (i32.const 3) (i32.const 0)
      (i64.const 0) (i64.const 0) (i32.const 0) (i32.const 40)))
    (i32.store8 (i32.const 16) (local.get $ret))
    (i32.store16 (i32.const 17) (local.get $einval))
    (i32.store16 (i32.const 19) (local.get $caught))
    (i32.store16 (i32.const 21) (i32.load (i32.const 40)))
    (drop (call $fd_write
      (i32.const 1) (i32.const 8) (i32.const 1) (i32.const 24)))))
