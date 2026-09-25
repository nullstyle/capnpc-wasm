;; Bulk memory and table operations run once per call with the size the
;; caller passes, plus a fill whose constant size is below one tick. The
;; instrumented copies poll only when a size uses up the countdown, and a
;; stop answer traps before the operation runs. `byte` reads memory back.
(module
  (memory (export "memory") 2)
  (table $table 1024 funcref)
  (func (export "fill") (param $size i32)
    (memory.fill (i32.const 0) (i32.const 7) (local.get $size)))
  (func (export "copy") (param $size i32)
    (memory.copy (i32.const 65536) (i32.const 0) (local.get $size)))
  (func (export "table_fill") (param $size i32)
    (table.fill $table (i32.const 0) (ref.null func) (local.get $size)))
  (func (export "small")
    (memory.fill (i32.const 0) (i32.const 7) (i32.const 1023)))
  (func (export "byte") (param $address i32) (result i32)
    (i32.load8_u (local.get $address))))
