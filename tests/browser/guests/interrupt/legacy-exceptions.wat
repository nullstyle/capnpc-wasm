;; Legacy exception-handling opcodes (try, catch, catch_all, delegate,
;; rethrow) that older toolchains still emit. The rewriter must parse them;
;; the SDK test compares the export's result before and after instrumentation.
(module
  (tag $e (param i32))
  (memory 1)
  (func (export "legacy") (result i32)
    try (result i32)
      try (result i32)
        try (result i32)
          i32.const 3
          throw $e
        delegate 0
      catch $e
        drop
        rethrow 0
      end
    catch $e
    catch_all
      i32.const 9
    end))
