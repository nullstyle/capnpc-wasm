;; Instruction coverage for the interruption rewriter. Each export computes a
;; number with a different group of instructions; the SDK test runs every
;; export before and after instrumentation and requires equal results, and
;; the rewrite must validate. Not a WASI command: the test instantiates it
;; directly with env.add and env.base.
(module
  (type $binary (func (param i32 i32) (result i32)))
  (type $nullary (func (result i32)))
  (import "env" "add" (func $add (type $binary)))
  (import "env" "base" (global $base i32))
  (tag $problem (param i32))
  (memory 1 2)
  (table $functions 8 funcref)
  (table $references 1 externref)
  (global $started (mut i32) (i32.const 0))
  (global $sum i32 (i32.add (global.get $base) (i32.const 2)))
  (global $pointer (ref null $binary) (ref.func $multiply))
  (elem (i32.const 0) func $multiply $subtract $identity)
  (elem $passive func $multiply $identity)
  (elem declare func $answer)
  (elem $expressions funcref (ref.func $subtract) (ref.null func))
  (data $bytes "\01\02\03\04\05\06\07\08")
  (data (i32.const 256) "coverage")
  (start $begin)
  (func $begin (global.set $started (i32.const 7)))
  (func $multiply (type $binary) (i32.mul (local.get 0) (local.get 1)))
  (func $subtract (type $binary) (i32.sub (local.get 0) (local.get 1)))
  (func $identity (type $binary) (local.get 0))
  (func $answer (type $nullary) (i32.const 42))
  (func $raise (param i32) (throw $problem (local.get 0)))
  (func $tail (param i32 i32) (result i32)
    (return_call $multiply (local.get 0) (local.get 1)))
  (func $tail_import (param i32 i32) (result i32)
    (return_call $add (local.get 0) (local.get 1)))
  (func $tail_indirect (param i32 i32 i32) (result i32)
    (return_call_indirect $functions (type $binary)
      (local.get 0) (local.get 1) (local.get 2)))
  (func $tail_ref (param i32 i32) (result i32)
    (return_call_ref $binary (local.get 0) (local.get 1)
      (ref.as_non_null (global.get $pointer))))
  (func (export "calls") (result i32)
    (i32.add
      (i32.add
        (call $tail (i32.const 6) (i32.const 7))
        (call $tail_import (i32.const 1) (i32.const 2)))
      (i32.add
        (i32.add
          (call $tail_indirect (i32.const 9) (i32.const 4) (i32.const 1))
          (call $tail_ref (i32.const 3) (i32.const 5)))
        (i32.add
          (call_ref $nullary (ref.func $answer))
          (call $add (i32.const 20) (i32.const 22))))))
  (func (export "loops") (result i32)
    (local $i i32) (local $total i32)
    (loop $next
      (block $done
        (block $odd
          (block $even
            (br_table $even $odd $done
              (select (result i32)
                (i32.and (local.get $i) (i32.const 1))
                (i32.const 2)
                (i32.lt_u (local.get $i) (i32.const 40)))))
          (local.set $total (i32.add (local.get $total) (local.get $i)))
          (br $done))
        (local.set $total (i32.sub (local.get $total) (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $next (i32.lt_u (local.get $i) (i32.const 41))))
    (local.get $total))
  (func (export "multivalue") (result i32)
    (local $n i32)
    i32.const 5
    loop $again (param i32) (result i32)
      i32.const 1
      i32.sub
      local.tee $n
      local.get $n
      br_if $again
    end
    i32.const 100
    i32.add)
  (func (export "memory") (result i32)
    (memory.fill (i32.const 16) (i32.const 7) (i32.const 8))
    (memory.init $bytes (i32.const 32) (i32.const 0) (i32.const 8))
    (data.drop $bytes)
    (memory.copy (i32.const 48) (i32.const 32) (i32.const 8))
    (i32.store offset=4 (i32.const 64) (i32.const -1))
    (drop (memory.grow (i32.const 1)))
    (drop (i32.atomic.rmw.add (i32.const 80) (i32.const 5)))
    (atomic.fence)
    (drop (memory.atomic.notify (i32.const 80) (i32.const 1)))
    (i32.add
      (i32.add (i32.load8_u (i32.const 20)) (i32.load (i32.const 48)))
      (i32.add
        (i32.extend8_s (i32.load8_u (i32.const 68)))
        (i32.add (memory.size) (i32.atomic.load (i32.const 80))))))
  (func (export "simd") (result i32)
    (local $v v128)
    (local.set $v (v128.const i32x4 1 2 3 4))
    (local.set $v (i8x16.shuffle 4 5 6 7 0 1 2 3 12 13 14 15 8 9 10 11
      (local.get $v) (local.get $v)))
    (local.set $v (i32x4.replace_lane 3 (local.get $v) (i32.const 10)))
    (v128.store (i32.const 128) (local.get $v))
    (local.set $v (v128.load32_zero (i32.const 132)))
    (local.set $v (v128.load8_lane 1 (i32.const 256) (local.get $v)))
    (v128.store16_lane 0 (i32.const 144) (local.get $v))
    (local.set $v (i8x16.swizzle (local.get $v) (i8x16.splat (i32.const 1))))
    (local.set $v (i8x16.relaxed_swizzle (local.get $v)
      (v128.const i8x16 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15)))
    (i32.add
      (i32x4.extract_lane 0 (local.get $v))
      (i32.load16_u (i32.const 144))))
  (func (export "exceptions") (result i32)
    (local $total i32)
    block $caught (result i32)
      try_table (catch $problem $caught)
        i32.const 5
        call $raise
      end
      i32.const 0
    end
    local.set $total
    block $caught_ref (result i32 exnref)
      try_table (catch_ref $problem $caught_ref)
        i32.const 7
        call $raise
      end
      unreachable
    end
    drop
    local.get $total
    i32.add
    local.set $total
    block $all
      try_table (catch_all $all)
        i32.const 1
        call $raise
      end
    end
    block $outer (result i32)
      try_table (catch $problem $outer)
        block $inner (result exnref)
          try_table (catch_all_ref $inner)
            i32.const 11
            call $raise
          end
          unreachable
        end
        throw_ref
      end
      i32.const 0
    end
    local.get $total
    i32.add
    i32.const 100
    i32.add)
  (func (export "references") (result i32)
    (local $total i32)
    (table.set $functions (i32.const 5) (ref.func $answer))
    (table.init $functions $passive (i32.const 6) (i32.const 0) (i32.const 2))
    (elem.drop $passive)
    (table.copy $functions $functions (i32.const 3) (i32.const 0) (i32.const 1))
    (drop (table.grow $references (ref.null extern) (i32.const 2)))
    (table.fill $references (i32.const 0) (ref.null extern) (i32.const 2))
    (local.set $total
      (i32.add (table.size $functions) (table.size $references)))
    (local.set $total (i32.add (local.get $total)
      (ref.is_null (table.get $functions (i32.const 4)))))
    (local.set $total (i32.add (local.get $total)
      (call_indirect $functions (type $binary)
        (i32.const 6) (i32.const 3) (i32.const 3))))
    (block $null
      (local.set $total (i32.add (local.get $total)
        (call_ref $binary (i32.const 2) (i32.const 2)
          (br_on_null $null (global.get $pointer))))))
    (block $present (result (ref $binary))
      (br_on_non_null $present (global.get $pointer))
      (unreachable))
    (drop)
    (local.get $total))
  (func (export "numeric") (result i64)
    (i64.add
      (i64.trunc_sat_f64_s (f64.const 1e30))
      (i64.add
        (i64.const -9000000000)
        (i64.extend_i32_s (i32.trunc_sat_f32_u (f32.const -3.5))))))
  (func (export "globals") (result i32)
    (i32.add (global.get $started) (global.get $sum))))
