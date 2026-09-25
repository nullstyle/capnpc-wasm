;; Host stops must trap. This guest catches every exception and retries, so a
;; stop delivered as a JavaScript exception would run its handler. The first
;; stdin byte selects the body: 0 spins, 1 exits with status 3, 2 writes one
;; byte to stdout (run it with stdoutBytes 0), 3 calls sock_recv, which the
;; host shim fails by throwing, 4 sleeps for an hour in poll_oneoff, and 5
;; tail-calls between two functions forever with no loop instruction. The
;; handler writes "H" to stderr and retries at most three times, then returns
;; normally, so a stop that throws finishes the job instead of stopping it.
(module
  (import "wasi_snapshot_preview1" "fd_read"
    (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (import "wasi_snapshot_preview1" "sock_recv"
    (func $sock_recv (param i32 i32 i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "poll_oneoff"
    (func $poll_oneoff (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  ;; iovecs: stdin byte at 64, "H" at 72, "x" at 73
  (data (i32.const 0) "\40\00\00\00\01\00\00\00")
  (data (i32.const 8) "\48\00\00\00\01\00\00\00")
  (data (i32.const 16) "\49\00\00\00\01\00\00\00")
  (data (i32.const 72) "Hx")
  ;; One relative monotonic clock subscription at 128: id at +16, one hour
  ;; (3.6e12 ns) at +24. The event goes to 192.
  (data (i32.const 144) "\01\00\00\00")
  (data (i32.const 152) "\00\a0\b8\30\46\03\00\00")
  (func $ping (return_call $pong))
  (func $pong (return_call $ping))
  (func $body (param $mode i32)
    (if (i32.eqz (local.get $mode))
      (then (loop $spin (br $spin))))
    (if (i32.eq (local.get $mode) (i32.const 1))
      (then (call $proc_exit (i32.const 3))))
    (if (i32.eq (local.get $mode) (i32.const 2))
      (then (drop (call $fd_write
        (i32.const 1) (i32.const 16) (i32.const 1) (i32.const 96)))))
    (if (i32.eq (local.get $mode) (i32.const 3))
      (then (drop (call $sock_recv
        (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)
        (i32.const 96) (i32.const 100)))))
    (if (i32.eq (local.get $mode) (i32.const 4))
      (then (drop (call $poll_oneoff
        (i32.const 128) (i32.const 192) (i32.const 1) (i32.const 96)))))
    (if (i32.eq (local.get $mode) (i32.const 5))
      (then (call $ping))))
  (func (export "_start")
    (local $tries i32)
    (drop (call $fd_read (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 96)))
    (block $done
      (loop $retry
        (block $caught
          (try_table (catch_all $caught)
            (call $body (i32.load8_u (i32.const 64))))
          (br $done))
        (drop (call $fd_write
          (i32.const 2) (i32.const 8) (i32.const 1) (i32.const 96)))
        (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
        (br_if $retry (i32.lt_u (local.get $tries) (i32.const 3)))))))
