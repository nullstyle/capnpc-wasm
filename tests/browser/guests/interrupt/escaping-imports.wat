;; Imports used as values: a table entry, a `ref.func` declared by an element
;; segment, and one declared only by an export. The test host's `stop` and
;; `exported` record a stop and zero the countdown; `log` records progress.
;; Once instrumented, every call that reaches `stop` or `exported` must trap
;; before the guest logs again, whether it went through the table, a
;; reference, or a tail call. With a host that never stops, each export
;; returns its own number after logging it.
(module
  (type $void (func))
  (import "env" "stop" (func $stop))
  (import "env" "log" (func $log (param i32)))
  (import "env" "exported" (func $exported))
  (table $table 1 funcref)
  (elem (table $table) (i32.const 0) func $stop)
  (memory (export "memory") 1)
  (export "exported" (func $exported))
  (func $tail (param i32)
    (return_call_indirect $table (type $void) (local.get 0)))
  (func (export "table") (result i32)
    (call_indirect $table (type $void) (i32.const 0))
    (call $log (i32.const 1))
    (i32.const 1))
  (func (export "tail") (result i32)
    (call $tail (i32.const 0))
    (call $log (i32.const 2))
    (i32.const 2))
  (func (export "reference") (result i32)
    (call_ref $void (ref.func $stop))
    (call $log (i32.const 3))
    (i32.const 3))
  (func (export "declared_by_export") (result i32)
    (call_ref $void (ref.func $exported))
    (call $log (i32.const 4))
    (i32.const 4)))
