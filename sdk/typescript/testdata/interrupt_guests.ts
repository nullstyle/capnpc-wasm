/**
 * Pre-assembled guests for the interruption tests (interrupt_test.ts). Each
 * constant's WebAssembly text is shown above it. The bytes are the pinned
 * wasm-tools output of `wasm-tools parse <name>.wat | wasm-tools strip --all`,
 * except namedTrapGuest, which keeps the name section `wasm-tools parse`
 * emits. SDK tests run with --allow-read only and cannot spawn wasm-tools.
 */

function wasm(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
}

/** Bodies of catchRetryGuest, selected by the first stdin byte. */
export const catchRetryMode = {
  spin: 0,
  exit: 1,
  stdout: 2,
  hostThrow: 3,
  sleep: 4,
  tailCalls: 5,
} as const;

// ;; Host stops must trap. This guest catches every exception and retries, so a
// ;; stop delivered as a JavaScript exception would run its handler. The first
// ;; stdin byte selects the body: 0 spins, 1 exits with status 3, 2 writes one
// ;; byte to stdout (run it with stdoutBytes 0), 3 calls sock_recv, which the
// ;; host shim fails by throwing, 4 sleeps for an hour in poll_oneoff, and 5
// ;; tail-calls between two functions forever with no loop instruction. The
// ;; handler writes "H" to stderr and retries at most three times, then returns
// ;; normally, so a stop that throws finishes the job instead of stopping it.
// (module
//   (import "wasi_snapshot_preview1" "fd_read"
//     (func $fd_read (param i32 i32 i32 i32) (result i32)))
//   (import "wasi_snapshot_preview1" "fd_write"
//     (func $fd_write (param i32 i32 i32 i32) (result i32)))
//   (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
//   (import "wasi_snapshot_preview1" "sock_recv"
//     (func $sock_recv (param i32 i32 i32 i32 i32 i32) (result i32)))
//   (import "wasi_snapshot_preview1" "poll_oneoff"
//     (func $poll_oneoff (param i32 i32 i32 i32) (result i32)))
//   (memory (export "memory") 1)
//   ;; iovecs: stdin byte at 64, "H" at 72, "x" at 73
//   (data (i32.const 0) "\40\00\00\00\01\00\00\00")
//   (data (i32.const 8) "\48\00\00\00\01\00\00\00")
//   (data (i32.const 16) "\49\00\00\00\01\00\00\00")
//   (data (i32.const 72) "Hx")
//   ;; One relative monotonic clock subscription at 128: id at +16, one hour
//   ;; (3.6e12 ns) at +24. The event goes to 192.
//   (data (i32.const 144) "\01\00\00\00")
//   (data (i32.const 152) "\00\a0\b8\30\46\03\00\00")
//   (func $ping (return_call $pong))
//   (func $pong (return_call $ping))
//   (func $body (param $mode i32)
//     (if (i32.eqz (local.get $mode))
//       (then (loop $spin (br $spin))))
//     (if (i32.eq (local.get $mode) (i32.const 1))
//       (then (call $proc_exit (i32.const 3))))
//     (if (i32.eq (local.get $mode) (i32.const 2))
//       (then (drop (call $fd_write
//         (i32.const 1) (i32.const 16) (i32.const 1) (i32.const 96)))))
//     (if (i32.eq (local.get $mode) (i32.const 3))
//       (then (drop (call $sock_recv
//         (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)
//         (i32.const 96) (i32.const 100)))))
//     (if (i32.eq (local.get $mode) (i32.const 4))
//       (then (drop (call $poll_oneoff
//         (i32.const 128) (i32.const 192) (i32.const 1) (i32.const 96)))))
//     (if (i32.eq (local.get $mode) (i32.const 5))
//       (then (call $ping))))
//   (func (export "_start")
//     (local $tries i32)
//     (drop (call $fd_read (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 96)))
//     (block $done
//       (loop $retry
//         (block $caught
//           (try_table (catch_all $caught)
//             (call $body (i32.load8_u (i32.const 64))))
//           (br $done))
//         (drop (call $fd_write
//           (i32.const 2) (i32.const 8) (i32.const 1) (i32.const 96)))
//         (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
//         (br_if $retry (i32.lt_u (local.get $tries) (i32.const 3)))))))
export const catchRetryGuest = wasm(
  "0061736d01000000011a0460047f7f7f7f017f60017f0060067f7f7f7f7f7f017f600000" +
    "02af010516776173695f736e617073686f745f70726576696577310766645f7265616400" +
    "0016776173695f736e617073686f745f70726576696577310866645f7772697465000016" +
    "776173695f736e617073686f745f70726576696577310970726f635f6578697400011677" +
    "6173695f736e617073686f745f707265766965773109736f636b5f726563760002167761" +
    "73695f736e617073686f745f70726576696577310b706f6c6c5f6f6e656f666600000305" +
    "04030301030503010001071302066d656d6f72790200065f737461727400080ab6010404" +
    "0012060b040012050b6600200045044003400c000b0b20004101460440410310020b2000" +
    "410246044041014110410141e00010011a0b20004103460440410041004100410041e000" +
    "41e40010031a0b2000410446044041800141c001410141e00010041a0b20004105460440" +
    "10050b0b4301017f41004100410141e00010001a0240034002401f4001020041c0002d00" +
    "0010070b0c020b41024108410141e00010011a200041016a210020004103490d000b0b0b" +
    "0b48060041000b0840000000010000000041080b0848000000010000000041100b084900" +
    "0000010000000041c8000b024878004190010b0401000000004198010b0800a0b8304603" +
    "0000",
);

// ;; Instrumentation shifts every defined function index by one, so the name
// ;; section has to shift with it: a trap backtrace from the instrumented guest
// ;; must still name $bravo, called from $charlie. Assembled without strip so
// ;; the name section (function and local names, no labels) stays.
// (module
//   (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
//   (memory (export "memory") 1)
//   (func $alpha (result i32) (i32.const 1))
//   (func $bravo (local $scratch i32)
//     (local.set $scratch (call $alpha))
//     (unreachable))
//   (func $charlie (call $bravo))
//   (func (export "_start") (call $charlie)))
export const namedTrapGuest = wasm(
  "0061736d01000000010c0360017f006000017f60000002240116776173695f736e617073" +
    "686f745f70726576696577310970726f635f657869740000030504010202020503010001" +
    "071302066d656d6f72790200065f737461727400040a1a04040041010b0901017f100121" +
    "00000b040010020b040010030b0038046e616d65012304000970726f635f657869740105" +
    "616c7068610205627261766f0307636861726c6965020c010201000773637261746368",
);

// ;; Instruction coverage for the interruption rewriter. Each export computes a
// ;; number with a different group of instructions; the SDK test runs every
// ;; export before and after instrumentation and requires equal results, and
// ;; the rewrite must validate. Not a WASI command: the test instantiates it
// ;; directly with env.add and env.base.
// (module
//   (type $binary (func (param i32 i32) (result i32)))
//   (type $nullary (func (result i32)))
//   (import "env" "add" (func $add (type $binary)))
//   (import "env" "base" (global $base i32))
//   (tag $problem (param i32))
//   (memory 1 2)
//   (table $functions 8 funcref)
//   (table $references 1 externref)
//   (global $started (mut i32) (i32.const 0))
//   (global $sum i32 (i32.add (global.get $base) (i32.const 2)))
//   (global $pointer (ref null $binary) (ref.func $multiply))
//   (elem (i32.const 0) func $multiply $subtract $identity)
//   (elem $passive func $multiply $identity)
//   (elem declare func $answer)
//   (elem $expressions funcref (ref.func $subtract) (ref.null func))
//   (data $bytes "\01\02\03\04\05\06\07\08")
//   (data (i32.const 256) "coverage")
//   (start $begin)
//   (func $begin (global.set $started (i32.const 7)))
//   (func $multiply (type $binary) (i32.mul (local.get 0) (local.get 1)))
//   (func $subtract (type $binary) (i32.sub (local.get 0) (local.get 1)))
//   (func $identity (type $binary) (local.get 0))
//   (func $answer (type $nullary) (i32.const 42))
//   (func $raise (param i32) (throw $problem (local.get 0)))
//   (func $tail (param i32 i32) (result i32)
//     (return_call $multiply (local.get 0) (local.get 1)))
//   (func $tail_import (param i32 i32) (result i32)
//     (return_call $add (local.get 0) (local.get 1)))
//   (func $tail_indirect (param i32 i32 i32) (result i32)
//     (return_call_indirect $functions (type $binary)
//       (local.get 0) (local.get 1) (local.get 2)))
//   (func $tail_ref (param i32 i32) (result i32)
//     (return_call_ref $binary (local.get 0) (local.get 1)
//       (ref.as_non_null (global.get $pointer))))
//   (func (export "calls") (result i32)
//     (i32.add
//       (i32.add
//         (call $tail (i32.const 6) (i32.const 7))
//         (call $tail_import (i32.const 1) (i32.const 2)))
//       (i32.add
//         (i32.add
//           (call $tail_indirect (i32.const 9) (i32.const 4) (i32.const 1))
//           (call $tail_ref (i32.const 3) (i32.const 5)))
//         (i32.add
//           (call_ref $nullary (ref.func $answer))
//           (call $add (i32.const 20) (i32.const 22))))))
//   (func (export "loops") (result i32)
//     (local $i i32) (local $total i32)
//     (loop $next
//       (block $done
//         (block $odd
//           (block $even
//             (br_table $even $odd $done
//               (select (result i32)
//                 (i32.and (local.get $i) (i32.const 1))
//                 (i32.const 2)
//                 (i32.lt_u (local.get $i) (i32.const 40)))))
//           (local.set $total (i32.add (local.get $total) (local.get $i)))
//           (br $done))
//         (local.set $total (i32.sub (local.get $total) (i32.const 1))))
//       (local.set $i (i32.add (local.get $i) (i32.const 1)))
//       (br_if $next (i32.lt_u (local.get $i) (i32.const 41))))
//     (local.get $total))
//   (func (export "multivalue") (result i32)
//     (local $n i32)
//     i32.const 5
//     loop $again (param i32) (result i32)
//       i32.const 1
//       i32.sub
//       local.tee $n
//       local.get $n
//       br_if $again
//     end
//     i32.const 100
//     i32.add)
//   (func (export "memory") (result i32)
//     (memory.fill (i32.const 16) (i32.const 7) (i32.const 8))
//     (memory.init $bytes (i32.const 32) (i32.const 0) (i32.const 8))
//     (data.drop $bytes)
//     (memory.copy (i32.const 48) (i32.const 32) (i32.const 8))
//     (i32.store offset=4 (i32.const 64) (i32.const -1))
//     (drop (memory.grow (i32.const 1)))
//     (drop (i32.atomic.rmw.add (i32.const 80) (i32.const 5)))
//     (atomic.fence)
//     (drop (memory.atomic.notify (i32.const 80) (i32.const 1)))
//     (i32.add
//       (i32.add (i32.load8_u (i32.const 20)) (i32.load (i32.const 48)))
//       (i32.add
//         (i32.extend8_s (i32.load8_u (i32.const 68)))
//         (i32.add (memory.size) (i32.atomic.load (i32.const 80))))))
//   (func (export "simd") (result i32)
//     (local $v v128)
//     (local.set $v (v128.const i32x4 1 2 3 4))
//     (local.set $v (i8x16.shuffle 4 5 6 7 0 1 2 3 12 13 14 15 8 9 10 11
//       (local.get $v) (local.get $v)))
//     (local.set $v (i32x4.replace_lane 3 (local.get $v) (i32.const 10)))
//     (v128.store (i32.const 128) (local.get $v))
//     (local.set $v (v128.load32_zero (i32.const 132)))
//     (local.set $v (v128.load8_lane 1 (i32.const 256) (local.get $v)))
//     (v128.store16_lane 0 (i32.const 144) (local.get $v))
//     (local.set $v (i8x16.swizzle (local.get $v) (i8x16.splat (i32.const 1))))
//     (local.set $v (i8x16.relaxed_swizzle (local.get $v)
//       (v128.const i8x16 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15)))
//     (i32.add
//       (i32x4.extract_lane 0 (local.get $v))
//       (i32.load16_u (i32.const 144))))
//   (func (export "exceptions") (result i32)
//     (local $total i32)
//     block $caught (result i32)
//       try_table (catch $problem $caught)
//         i32.const 5
//         call $raise
//       end
//       i32.const 0
//     end
//     local.set $total
//     block $caught_ref (result i32 exnref)
//       try_table (catch_ref $problem $caught_ref)
//         i32.const 7
//         call $raise
//       end
//       unreachable
//     end
//     drop
//     local.get $total
//     i32.add
//     local.set $total
//     block $all
//       try_table (catch_all $all)
//         i32.const 1
//         call $raise
//       end
//     end
//     block $outer (result i32)
//       try_table (catch $problem $outer)
//         block $inner (result exnref)
//           try_table (catch_all_ref $inner)
//             i32.const 11
//             call $raise
//           end
//           unreachable
//         end
//         throw_ref
//       end
//       i32.const 0
//     end
//     local.get $total
//     i32.add
//     i32.const 100
//     i32.add)
//   (func (export "references") (result i32)
//     (local $total i32)
//     (table.set $functions (i32.const 5) (ref.func $answer))
//     (table.init $functions $passive (i32.const 6) (i32.const 0) (i32.const 2))
//     (elem.drop $passive)
//     (table.copy $functions $functions (i32.const 3) (i32.const 0) (i32.const 1))
//     (drop (table.grow $references (ref.null extern) (i32.const 2)))
//     (table.fill $references (i32.const 0) (ref.null extern) (i32.const 2))
//     (local.set $total
//       (i32.add (table.size $functions) (table.size $references)))
//     (local.set $total (i32.add (local.get $total)
//       (ref.is_null (table.get $functions (i32.const 4)))))
//     (local.set $total (i32.add (local.get $total)
//       (call_indirect $functions (type $binary)
//         (i32.const 6) (i32.const 3) (i32.const 3))))
//     (block $null
//       (local.set $total (i32.add (local.get $total)
//         (call_ref $binary (i32.const 2) (i32.const 2)
//           (br_on_null $null (global.get $pointer))))))
//     (block $present (result (ref $binary))
//       (br_on_non_null $present (global.get $pointer))
//       (unreachable))
//     (drop)
//     (local.get $total))
//   (func (export "numeric") (result i64)
//     (i64.add
//       (i64.trunc_sat_f64_s (f64.const 1e30))
//       (i64.add
//         (i64.const -9000000000)
//         (i64.extend_i32_s (i32.trunc_sat_f32_u (f32.const -3.5))))))
//   (func (export "globals") (result i32)
//     (i32.add (global.get $started) (global.get $sum))))
export const rewriterCoverageModule = wasm(
  "0061736d0100000001270860027f7f017f6000017f60017f0060000060037f7f7f017f60" +
    "017f017f6000027f696000017e02170203656e7603616464000003656e76046261736503" +
    "7f00031413030000000102000004000101010101010107010407027000086f0001050401" +
    "0101020d030100020614037f0141000b7f00230041026a0b630000d2020b075c09056361" +
    "6c6c73000b056c6f6f7073000c0a6d756c746976616c7565000d066d656d6f7279000e04" +
    "73696d64000f0a657863657074696f6e7300100a7265666572656e6365730011076e756d" +
    "65726963001207676c6f62616c730013080101091b040041000b03020304010002020403" +
    "000105057002d2030bd0700b0c01020ac505130600410724010b0700200020016c0b0700" +
    "200020016b0b040020000b0400412a0b0600200008000b08002000200112020b08002000" +
    "200112000b0b002000200120021300000b0b00200020012303d415000b2b004106410710" +
    "074101410210086a410941044101100941034105100a6ad20514014114411610006a6a6a" +
    "0b4401027f03400240024002402000410171410220004128491c017f0e020001020b2001" +
    "20006a21010c010b200141016b21010b200041016a210020004129490d000b20010b1601" +
    "017f4105030541016b220020000d000b41e4006a0b6400411041074108fc0b0041204100" +
    "4108fc080000fc0900413041204108fc0a000041c000417f360204410140001a41d00041" +
    "05fe1e02001afe030041d0004101fe0002001a41142d000041302802006a41c4002d0000" +
    "c03f0041d000fe1002006a6a6a0b900101017bfd0c010000000200000003000000040000" +
    "00210020002000fd0d04050607000102030c0d0e0f08090a0b21002000410afd1c032100" +
    "4180012000fd0b0400418401fd5c020021004180022000fd5400000121004190012000fd" +
    "5901000020004101fd0ffd0e21002000fd0c000102030405060708090a0b0c0d0e0ffd80" +
    "0221002000fd1b004190012f01006a0b5a01017f027f1f4001000000410510060b41000b" +
    "210002061f4001010000410710060b000b1a20006a210002401f40010200410110060b0b" +
    "027f1f400100000002691f40010300410b10060b000b0a0b41000b20006a41e4006a0b71" +
    "01017f4105d2052600410641004102fc0c0100fc0d01410341004101fc0e0000d06f4102" +
    "fc0f011a4100d06f4102fc1101fc1000fc10016a2100200041042500d16a210020004106" +
    "410341031100006a210002402000410241022303d50014006a21000b0264002303d60000" +
    "0b1a20000b1d0044ea8ca039593e2946fc064280ccbbbc5e43000060c0fc01ac7c7c0b07" +
    "00230123026a0b0b190201080102030405060708004180020b08636f766572616765",
);

// ;; Legacy exception-handling opcodes (try, catch, catch_all, delegate,
// ;; rethrow) that older toolchains still emit. The rewriter must parse them;
// ;; the SDK test compares the export's result before and after instrumentation.
// (module
//   (tag $e (param i32))
//   (memory 1)
//   (func (export "legacy") (result i32)
//     try (result i32)
//       try (result i32)
//         try (result i32)
//           i32.const 3
//           throw $e
//         delegate 0
//       catch $e
//         drop
//         rethrow 0
//       end
//     catch $e
//     catch_all
//       i32.const 9
//     end))
export const legacyExceptionsModule = wasm(
  "0061736d0100000001090260017f006000017f0302010105030100010d03010000070a01" +
    "066c656761637900000a1c011a00067f067f067f41030800180007001a09000b07001941" +
    "090b0b",
);
