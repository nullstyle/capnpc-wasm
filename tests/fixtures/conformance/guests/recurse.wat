;; Unbounded recursion: every engine must report an exhausted call stack as a
;; trap of the stack kind, whichever text it uses for it.
(module
  (memory (export "memory") 1)
  (func $r (param i32) (result i32) (call $r (i32.add (local.get 0) (i32.const 1))))
  (func (export "_start") (drop (call $r (i32.const 0)))))
