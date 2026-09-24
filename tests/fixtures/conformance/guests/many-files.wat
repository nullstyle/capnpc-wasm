;; A generator that creates 5,000 empty files f00000 to f04999, 904 over the
;; default outputEntries budget. Exits 100 plus the errno of a failed open.
(module
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close" (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "f00000")
  (func $digit (param $pos i32) (param $v i32)
    (i32.store8 (local.get $pos) (i32.add (i32.const 48) (local.get $v))))
  (func (export "_start")
    (local $i i32) (local $err i32)
    (block $done (loop $l
      (br_if $done (i32.ge_u (local.get $i) (i32.const 5000)))
      (call $digit (i32.const 1) (i32.rem_u (i32.div_u (local.get $i) (i32.const 10000)) (i32.const 10)))
      (call $digit (i32.const 2) (i32.rem_u (i32.div_u (local.get $i) (i32.const 1000)) (i32.const 10)))
      (call $digit (i32.const 3) (i32.rem_u (i32.div_u (local.get $i) (i32.const 100)) (i32.const 10)))
      (call $digit (i32.const 4) (i32.rem_u (i32.div_u (local.get $i) (i32.const 10)) (i32.const 10)))
      (call $digit (i32.const 5) (i32.rem_u (local.get $i) (i32.const 10)))
      (local.set $err (call $path_open (i32.const 3) (i32.const 0) (i32.const 0) (i32.const 6)
        (i32.const 9) (i64.const 0x1fffffff) (i64.const 0x1fffffff) (i32.const 0) (i32.const 48)))
      (if (local.get $err)
        (then (call $proc_exit (i32.add (i32.const 100) (local.get $err)))))
      (drop (call $fd_close (i32.load (i32.const 48))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (call $proc_exit (i32.const 0))))
