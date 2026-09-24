;; Loops forever without calling the host: only a deadline can end it.
(module
  (memory (export "memory") 1)
  (func (export "_start") (loop (br 0))))
