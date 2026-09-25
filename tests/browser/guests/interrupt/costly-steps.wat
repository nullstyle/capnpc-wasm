;; Loop steps that are one instruction but not one instruction's work, each
;; repeated until the job stops; the first stdin byte selects one. 0 fills
;; 16 MiB of memory, 1 fills a table of 1,048,576 entries, and 2 or more draws
;; 16 MiB from random_get. At one tick per iteration the next poll would come
;; minutes later, so the job stops in time only if bulk operations are charged
;; by size and every import polls the job before it acts.
(module
  (import "wasi_snapshot_preview1" "fd_read"
    (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "random_get"
    (func $random_get (param i32 i32) (result i32)))
  (memory (export "memory") 257)
  (table $table 1048576 funcref)
  (func (export "_start")
    (local $mode i32)
    ;; One iovec at 0 for one byte at 16, the count read at 8.
    (i32.store (i32.const 0) (i32.const 16))
    (i32.store (i32.const 4) (i32.const 1))
    (drop
      (call $fd_read (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 8)))
    (local.set $mode (i32.load8_u (i32.const 16)))
    (loop $again
      (block $random
        (block $table
          (block $memory
            (br_table $memory $table $random (local.get $mode)))
          (memory.fill (i32.const 0) (i32.const 0) (i32.const 16777216))
          (br $again))
        (table.fill $table (i32.const 0) (ref.null func) (i32.const 1048576))
        (br $again))
      (drop (call $random_get (i32.const 0) (i32.const 16777216)))
      (br $again))))
