/**
 * Pre-assembled guests for the SDK's host-bounds and output-shape tests. Each
 * source lives in tests/browser/guests/<name>.wat; the browser suite assembles
 * every file there with the pinned wasm-tools (`parse`, then `strip --all`)
 * and asserts that the bytes equal these constants, so the two copies cannot
 * drift. SDK tests run with --allow-read only and cannot spawn wasm-tools.
 *
 * Regenerate after editing a .wat file:
 *   wasm-tools parse tests/browser/guests/<name>.wat | wasm-tools strip --all | xxd -p
 */

const EINVAL = 28;
const EBADF = 8;
const ENFILE = 41;
const EPERM = 63;
const EROFS = 69;

export interface HostileGuest {
  /** Where the guest runs: the read-only compiler stage, or a writable generator. */
  stage: "compiler" | "generator";
  /** stdout bytes the guest reports (the compile result's `request`). */
  expectRequest?: number[];
  /** Generated files a generator-stage guest must publish. */
  expectOutputs?: Record<string, number[]>;
  /** The rejection the job must produce instead of a result. */
  expectError?: { name: string; message: string };
  bytes: Uint8Array;
}

function wasm(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
}

export const hostileGuests: Record<string, HostileGuest> = {
  // ;; Backslashes pass the shim's path parser but are not portable output names.
  // ;; Output collection must reject the job instead of publishing the file.
  // (module
  //   (import "wasi_snapshot_preview1" "fd_write"
  //     (func $fd_write (param i32 i32 i32 i32) (result i32)))
  //   (import "wasi_snapshot_preview1" "path_open"
  //     (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  //   (memory (export "memory") 1)
  //   (data (i32.const 32) "a\\b")
  //   (data (i32.const 64) "\50\00\00\00\01\00\00\00x")
  //   (func (export "_start")
  //     (drop (call $path_open
  //       (i32.const 3) (i32.const 0) (i32.const 32) (i32.const 3) (i32.const 1)
  //       (i64.const 64) (i64.const 0) (i32.const 0) (i32.const 128)))
  //     (drop (call $fd_write
  //       (i32.load (i32.const 128)) (i32.const 64) (i32.const 1) (i32.const 24)))))
  "bad-name-output": {
    stage: "generator",
    expectError: {
      name: "CompileError",
      message: "invalid filesystem entry name",
    },
    bytes: wasm(
      "0061736d0100000001190360047f7f7f7f017f60097f7f7f7f7f7e7e7f7f017f60000002" +
        "460216776173695f736e617073686f745f70726576696577310866645f77726974650000" +
        "16776173695f736e617073686f745f707265766965773109706174685f6f70656e000103" +
        "0201020503010001071302066d656d6f72790200065f737461727400020a2b0129004103" +
        "410041204103410142c0004200410041800110011a41800128020041c000410141181000" +
        "1a0b0b18020041200b03615c620041c0000b09500000000100000078",
    ),
  },
  // ;; Imports that only copy existing host data still write at guest pointers.
  // ;; Ranges outside memory must return EINVAL rather than trap; in-range calls
  // ;; keep working.
  // (module
  //   (import "wasi_snapshot_preview1" "fd_write"
  //     (func $fd_write (param i32 i32 i32 i32) (result i32)))
  //   (import "wasi_snapshot_preview1" "fd_readdir"
  //     (func $fd_readdir (param i32 i32 i32 i64 i32) (result i32)))
  //   (import "wasi_snapshot_preview1" "fd_prestat_dir_name"
  //     (func $fd_prestat_dir_name (param i32 i32 i32) (result i32)))
  //   (import "wasi_snapshot_preview1" "poll_oneoff"
  //     (func $poll_oneoff (param i32 i32 i32 i32) (result i32)))
  //   (memory (export "memory") 1)
  //   (data (i32.const 8) "\10\00\00\00\01\00\00\00")
  //   (func $report (param $errno i32)
  //     (i32.store8 (i32.const 16) (local.get $errno))
  //     (drop (call $fd_write
  //       (i32.const 1) (i32.const 8) (i32.const 1) (i32.const 24))))
  //   (func (export "_start")
  //     (call $report (call $fd_readdir
  //       (i32.const 3) (i32.const 0xffff0000) (i32.const 0x20000) (i64.const 0)
  //       (i32.const 24)))
  //     (call $report (call $fd_prestat_dir_name
  //       (i32.const 3) (i32.const 0xffffff00) (i32.const 0x1000)))
  //     (call $report (call $poll_oneoff
  //       (i32.const 0xffffff00) (i32.const 0) (i32.const 1) (i32.const 24)))
  //     ;; In range: list the root into 256 bytes, then copy the one-byte prestat name.
  //     (call $report (call $fd_readdir
  //       (i32.const 3) (i32.const 256) (i32.const 256) (i64.const 0)
  //       (i32.const 24)))
  //     (call $report (call $fd_prestat_dir_name
  //       (i32.const 3) (i32.const 512) (i32.const 1)))))
  "guest-pointers": {
    stage: "compiler",
    expectRequest: [EINVAL, EINVAL, EINVAL, 0, 0],
    bytes: wasm(
      "0061736d0100000001200560047f7f7f7f017f60057f7f7f7e7f017f60037f7f7f017f60" +
        "017f006000000299010416776173695f736e617073686f745f7072657669657731086664" +
        "5f7772697465000016776173695f736e617073686f745f70726576696577310a66645f72" +
        "656164646972000116776173695f736e617073686f745f70726576696577311366645f70" +
        "7265737461745f6469725f6e616d65000216776173695f736e617073686f745f70726576" +
        "696577310b706f6c6c5f6f6e656f6666000003030203040503010001071302066d656d6f" +
        "72790200065f737461727400050a5f021400411020003a0000410141084101411810001a" +
        "0b480041034180807c418080084200411810011004410341807e4180201002100441807e" +
        "410041014118100310044103418002418002420041181001100441034180044101100210" +
        "040b0b0e010041080b081000000001000000",
    ),
  },
  // ;; Every path_open keeps a host descriptor object alive until fd_close. A guest
  // ;; that never closes must hit the SDK's descriptor cap (ENFILE) instead of
  // ;; growing host memory with its CPU time. Reports the errno, then the count of
  // ;; successful opens as two little-endian bytes.
  // (module
  //   (import "wasi_snapshot_preview1" "fd_write"
  //     (func $fd_write (param i32 i32 i32 i32) (result i32)))
  //   (import "wasi_snapshot_preview1" "path_open"
  //     (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  //   (memory (export "memory") 1)
  //   (data (i32.const 8) "\10\00\00\00\03\00\00\00")
  //   (data (i32.const 32) "src")
  //   (func (export "_start") (local $count i32) (local $ret i32)
  //     (block $done
  //       (loop $again
  //         (local.set $ret (call $path_open
  //           (i32.const 3) (i32.const 0) (i32.const 32) (i32.const 3) (i32.const 0)
  //           (i64.const 0) (i64.const 0) (i32.const 0) (i32.const 40)))
  //         (br_if $done (local.get $ret))
  //         (local.set $count (i32.add (local.get $count) (i32.const 1)))
  //         (br_if $again (i32.lt_u (local.get $count) (i32.const 4096)))))
  //     (i32.store8 (i32.const 16) (local.get $ret))
  //     (i32.store16 (i32.const 17) (local.get $count))
  //     (drop (call $fd_write
  //       (i32.const 1) (i32.const 8) (i32.const 1) (i32.const 24)))))
  "open-flood": {
    stage: "compiler",
    // ENFILE after 1020 opens: the 1024 cap minus stdio and the preopen.
    expectRequest: [ENFILE, 0xfc, 0x03],
    bytes: wasm(
      "0061736d0100000001190360047f7f7f7f017f60097f7f7f7f7f7e7e7f7f017f60000002" +
        "460216776173695f736e617073686f745f70726576696577310866645f77726974650000" +
        "16776173695f736e617073686f745f707265766965773109706174685f6f70656e000103" +
        "0201020503010001071302066d656d6f72790200065f737461727400020a4e014c01027f" +
        "024003404103410041204103410042004200410041281001210120010d01200041016a21" +
        "002000418020490d000b0b411020013a0000411120003b0100410141084101411810001a" +
        "0b0b16020041080b0810000000030000000041200b03737263",
    ),
  },
  // ;; Generated file names are guest-chosen. A file named "__proto__" must arrive
  // ;; as an own property of a plain result object in both execution modes, next
  // ;; to an ordinary file "a".
  // (module
  //   (import "wasi_snapshot_preview1" "fd_write"
  //     (func $fd_write (param i32 i32 i32 i32) (result i32)))
  //   (import "wasi_snapshot_preview1" "fd_close"
  //     (func $fd_close (param i32) (result i32)))
  //   (import "wasi_snapshot_preview1" "path_open"
  //     (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  //   (memory (export "memory") 1)
  //   (data (i32.const 32) "__proto__")
  //   (data (i32.const 48) "a")
  //   (data (i32.const 64) "\50\00\00\00\01\00\00\00")
  //   (func $create (param $path i32) (param $length i32) (param $byte i32)
  //     (drop (call $path_open
  //       (i32.const 3) (i32.const 0) (local.get $path) (local.get $length)
  //       (i32.const 1) (i64.const 64) (i64.const 0) (i32.const 0) (i32.const 128)))
  //     (i32.store8 (i32.const 80) (local.get $byte))
  //     (drop (call $fd_write
  //       (i32.load (i32.const 128)) (i32.const 64) (i32.const 1) (i32.const 24)))
  //     (drop (call $fd_close (i32.load (i32.const 128)))))
  //   (func (export "_start")
  //     (call $create (i32.const 32) (i32.const 9) (i32.const 120))
  //     (call $create (i32.const 48) (i32.const 1) (i32.const 121))))
  "proto-output": {
    stage: "generator",
    expectOutputs: { ["__proto__"]: [120], a: [121] },
    bytes: wasm(
      "0061736d0100000001240560047f7f7f7f017f60017f017f60097f7f7f7f7f7e7e7f7f01" +
        "7f60037f7f7f0060000002680316776173695f736e617073686f745f7072657669657731" +
        "0866645f7772697465000016776173695f736e617073686f745f70726576696577310866" +
        "645f636c6f7365000116776173695f736e617073686f745f707265766965773109706174" +
        "685f6f70656e000203030203040503010001071302066d656d6f72790200065f73746172" +
        "7400040a51023a004103410020002001410142c0004200410041800110021a41d0002002" +
        "3a000041800128020041c0004101411810001a41800128020010011a0b14004120410941" +
        "f80010034130410141f90010030b0b23030041200b095f5f70726f746f5f5f0041300b01" +
        "610041c0000b085000000001000000",
    ),
  },
  // ;; random_get sizes host work from the guest's length. Out-of-range fills must
  // ;; return EINVAL without allocating; in-range fills happen in place, in 64 KiB
  // ;; chunks, so a fill larger than one chunk must still succeed.
  // (module
  //   (import "wasi_snapshot_preview1" "fd_write"
  //     (func $fd_write (param i32 i32 i32 i32) (result i32)))
  //   (import "wasi_snapshot_preview1" "random_get"
  //     (func $random_get (param i32 i32) (result i32)))
  //   (memory (export "memory") 2)
  //   (data (i32.const 8) "\10\00\00\00\01\00\00\00")
  //   (func $report (param $errno i32)
  //     (i32.store8 (i32.const 16) (local.get $errno))
  //     (drop (call $fd_write
  //       (i32.const 1) (i32.const 8) (i32.const 1) (i32.const 24))))
  //   (func (export "_start")
  //     (call $report (call $random_get (i32.const 0) (i32.const 0x7fffffff)))
  //     (call $report (call $random_get (i32.const 0xffff0000) (i32.const 0x20000)))
  //     ;; 66048 bytes at 256 cross the host's chunk boundary within two pages.
  //     (call $report (call $random_get (i32.const 256) (i32.const 66048)))
  //     ;; Sixteen random bytes are all zero with negligible probability.
  //     (call $report (i32.and
  //       (i64.eqz (i64.load (i32.const 256)))
  //       (i64.eqz (i64.load (i32.const 66296)))))))
  "random-fill": {
    stage: "compiler",
    expectRequest: [EINVAL, EINVAL, 0, 0],
    bytes: wasm(
      "0061736d0100000001160460047f7f7f7f017f60027f7f017f60017f0060000002470216" +
        "776173695f736e617073686f745f70726576696577310866645f77726974650000167761" +
        "73695f736e617073686f745f70726576696577310a72616e646f6d5f6765740001030302" +
        "02030503010002071302066d656d6f72790200065f737461727400030a4e021400411020" +
        "003a0000410141084101411810001a0b3700410041ffffffff07100110024180807c4180" +
        "80081001100241800241808404100110024180022903005041f88504290300507110020b" +
        "0b0e010041080b081000000001000000",
    ),
  },
  // ;; Read-side iovec arrays are sized by the guest. A one-page guest asking for
  // ;; 0x7fffffff iovecs, or naming a buffer outside memory, must get EINVAL back
  // ;; before the host allocates anything. Each errno is reported as one stdout byte.
  // (module
  //   (import "wasi_snapshot_preview1" "fd_write"
  //     (func $fd_write (param i32 i32 i32 i32) (result i32)))
  //   (import "wasi_snapshot_preview1" "fd_read"
  //     (func $fd_read (param i32 i32 i32 i32) (result i32)))
  //   (import "wasi_snapshot_preview1" "fd_pread"
  //     (func $fd_pread (param i32 i32 i32 i64 i32) (result i32)))
  //   (memory (export "memory") 1)
  //   (data (i32.const 8) "\10\00\00\00\01\00\00\00")
  //   (func $report (param $errno i32)
  //     (i32.store8 (i32.const 16) (local.get $errno))
  //     (drop (call $fd_write
  //       (i32.const 1) (i32.const 8) (i32.const 1) (i32.const 24))))
  //   (func (export "_start")
  //     ;; 0x7fffffff iovecs starting at address 0 cannot fit in one page.
  //     (call $report (call $fd_read
  //       (i32.const 0) (i32.const 0) (i32.const 0x7fffffff) (i32.const 24)))
  //     (call $report (call $fd_pread
  //       (i32.const 0) (i32.const 0) (i32.const 0x7fffffff) (i64.const 0)
  //       (i32.const 24)))
  //     ;; One iovec whose buffer lies outside memory.
  //     (i32.store (i32.const 0) (i32.const 0xfffff000))
  //     (i32.store (i32.const 4) (i32.const 16))
  //     (call $report (call $fd_read
  //       (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 24)))
  //     (call $report (call $fd_pread
  //       (i32.const 0) (i32.const 0) (i32.const 1) (i64.const 0) (i32.const 24)))
  //     ;; A valid read of the empty stdin succeeds with nothing read.
  //     (i32.store (i32.const 0) (i32.const 32))
  //     (i32.store (i32.const 4) (i32.const 8))
  //     (call $report (call $fd_read
  //       (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 24)))))
  "read-iovecs": {
    stage: "compiler",
    expectRequest: [EINVAL, EINVAL, EINVAL, EINVAL, 0],
    bytes: wasm(
      "0061736d0100000001190460047f7f7f7f017f60057f7f7f7e7f017f60017f0060000002" +
        "660316776173695f736e617073686f745f70726576696577310866645f77726974650000" +
        "16776173695f736e617073686f745f70726576696577310766645f726561640000167761" +
        "73695f736e617073686f745f70726576696577310866645f707265616400010303020203" +
        "0503010001071302066d656d6f72790200065f737461727400040a7e021400411020003a" +
        "0000410141084101411810001a0b67004100410041ffffffff0741181001100341004100" +
        "41ffffffff07420041181002100341004180603602004104411036020041004100410141" +
        "181001100341004100410142004118100210034100412036020041044108360200410041" +
        "0041014118100110030b0b0e010041080b081000000001000000",
    ),
  },
  // ;; The compiler's workspace is read-only. Every mutation must fail with EROFS,
  // ;; or with EPERM/EBADF where the shim itself refuses, leaving the snapshot
  // ;; intact. The workspace holds one file, src/a.
  // (module
  //   (import "wasi_snapshot_preview1" "fd_write"
  //     (func $fd_write (param i32 i32 i32 i32) (result i32)))
  //   (import "wasi_snapshot_preview1" "fd_pwrite"
  //     (func $fd_pwrite (param i32 i32 i32 i64 i32) (result i32)))
  //   (import "wasi_snapshot_preview1" "path_open"
  //     (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  //   (import "wasi_snapshot_preview1" "path_create_directory"
  //     (func $path_create_directory (param i32 i32 i32) (result i32)))
  //   (import "wasi_snapshot_preview1" "path_unlink_file"
  //     (func $path_unlink_file (param i32 i32 i32) (result i32)))
  //   (import "wasi_snapshot_preview1" "path_rename"
  //     (func $path_rename (param i32 i32 i32 i32 i32 i32) (result i32)))
  //   (import "wasi_snapshot_preview1" "path_remove_directory"
  //     (func $path_remove_directory (param i32 i32 i32) (result i32)))
  //   (import "wasi_snapshot_preview1" "path_link"
  //     (func $path_link (param i32 i32 i32 i32 i32 i32 i32) (result i32)))
  //   (import "wasi_snapshot_preview1" "path_symlink"
  //     (func $path_symlink (param i32 i32 i32 i32 i32) (result i32)))
  //   (import "wasi_snapshot_preview1" "path_filestat_set_times"
  //     (func $path_filestat_set_times (param i32 i32 i32 i32 i64 i64 i32)
  //       (result i32)))
  //   (import "wasi_snapshot_preview1" "fd_allocate"
  //     (func $fd_allocate (param i32 i64 i64) (result i32)))
  //   (import "wasi_snapshot_preview1" "fd_filestat_set_size"
  //     (func $fd_filestat_set_size (param i32 i64) (result i32)))
  //   (import "wasi_snapshot_preview1" "fd_filestat_set_times"
  //     (func $fd_filestat_set_times (param i32 i64 i64 i32) (result i32)))
  //   (memory (export "memory") 1)
  //   (data (i32.const 8) "\10\00\00\00\01\00\00\00")
  //   (data (i32.const 32) "src/a")
  //   (data (i32.const 40) "src/d")
  //   (data (i32.const 48) "src/b")
  //   (data (i32.const 56) "src")
  //   (data (i32.const 64) "a")
  //   (data (i32.const 72) "src/l")
  //   (data (i32.const 136) "\90\00\00\00\01\00\00\00y")
  //   (func $report (param $errno i32)
  //     (i32.store8 (i32.const 16) (local.get $errno))
  //     (drop (call $fd_write
  //       (i32.const 1) (i32.const 8) (i32.const 1) (i32.const 24))))
  //   (func (export "_start") (local $fd i32)
  //     ;; O_CREAT, O_TRUNC, then write rights on the existing file
  //     (call $report (call $path_open
  //       (i32.const 3) (i32.const 0) (i32.const 32) (i32.const 5) (i32.const 1)
  //       (i64.const 0) (i64.const 0) (i32.const 0) (i32.const 128)))
  //     (call $report (call $path_open
  //       (i32.const 3) (i32.const 0) (i32.const 32) (i32.const 5) (i32.const 8)
  //       (i64.const 0) (i64.const 0) (i32.const 0) (i32.const 128)))
  //     (call $report (call $path_open
  //       (i32.const 3) (i32.const 0) (i32.const 32) (i32.const 5) (i32.const 0)
  //       (i64.const 64) (i64.const 0) (i32.const 0) (i32.const 128)))
  //     (call $report (call $path_create_directory
  //       (i32.const 3) (i32.const 40) (i32.const 5)))
  //     (call $report (call $path_unlink_file
  //       (i32.const 3) (i32.const 32) (i32.const 5)))
  //     (call $report (call $path_rename
  //       (i32.const 3) (i32.const 32) (i32.const 5) (i32.const 3) (i32.const 48)
  //       (i32.const 5)))
  //     (call $report (call $path_remove_directory
  //       (i32.const 3) (i32.const 56) (i32.const 3)))
  //     (call $report (call $path_link
  //       (i32.const 3) (i32.const 0) (i32.const 32) (i32.const 5) (i32.const 3)
  //       (i32.const 48) (i32.const 5)))
  //     (call $report (call $path_symlink
  //       (i32.const 64) (i32.const 1) (i32.const 3) (i32.const 72) (i32.const 5)))
  //     (call $report (call $path_filestat_set_times
  //       (i32.const 3) (i32.const 0) (i32.const 32) (i32.const 5) (i64.const 0)
  //       (i64.const 0) (i32.const 0)))
  //     ;; A read-only open succeeds; descriptor mutations still fail.
  //     (call $report (call $path_open
  //       (i32.const 3) (i32.const 0) (i32.const 32) (i32.const 5) (i32.const 0)
  //       (i64.const 2) (i64.const 0) (i32.const 0) (i32.const 128)))
  //     (local.set $fd (i32.load (i32.const 128)))
  //     (call $report (call $fd_allocate
  //       (local.get $fd) (i64.const 0) (i64.const 1)))
  //     (call $report (call $fd_filestat_set_size (local.get $fd) (i64.const 0)))
  //     (call $report (call $fd_filestat_set_times
  //       (local.get $fd) (i64.const 0) (i64.const 0) (i32.const 0)))
  //     (call $report (call $fd_write
  //       (local.get $fd) (i32.const 136) (i32.const 1) (i32.const 24)))
  //     (call $report (call $fd_pwrite
  //       (local.get $fd) (i32.const 136) (i32.const 1) (i64.const 0)
  //       (i32.const 24)))))
  "readonly-ops": {
    stage: "compiler",
    expectRequest: [
      EROFS,
      EROFS,
      EPERM,
      EROFS,
      EROFS,
      EROFS,
      EROFS,
      EROFS,
      EROFS,
      EROFS,
      0,
      EROFS,
      EROFS,
      EROFS,
      EBADF,
      EBADF,
    ],
    bytes: wasm(
      "0061736d01000000016b0d60047f7f7f7f017f60057f7f7f7e7f017f60097f7f7f7f7f7e" +
        "7e7f7f017f60037f7f7f017f60067f7f7f7f7f7f017f60077f7f7f7f7f7f7f017f60057f" +
        "7f7f7f7f017f60077f7f7f7f7e7e7f017f60037f7e7e017f60027f7e017f60047f7e7e7f" +
        "017f60017f006000000292040d16776173695f736e617073686f745f7072657669657731" +
        "0866645f7772697465000016776173695f736e617073686f745f70726576696577310966" +
        "645f707772697465000116776173695f736e617073686f745f7072657669657731097061" +
        "74685f6f70656e000216776173695f736e617073686f745f707265766965773115706174" +
        "685f6372656174655f6469726563746f7279000316776173695f736e617073686f745f70" +
        "7265766965773110706174685f756e6c696e6b5f66696c65000316776173695f736e6170" +
        "73686f745f70726576696577310b706174685f72656e616d65000416776173695f736e61" +
        "7073686f745f707265766965773115706174685f72656d6f76655f6469726563746f7279" +
        "000316776173695f736e617073686f745f707265766965773109706174685f6c696e6b00" +
        "0516776173695f736e617073686f745f70726576696577310c706174685f73796d6c696e" +
        "6b000616776173695f736e617073686f745f707265766965773117706174685f66696c65" +
        "737461745f7365745f74696d6573000716776173695f736e617073686f745f7072657669" +
        "6577310b66645f616c6c6f63617465000816776173695f736e617073686f745f70726576" +
        "696577311466645f66696c65737461745f7365745f73697a65000916776173695f736e61" +
        "7073686f745f70726576696577311566645f66696c65737461745f7365745f74696d6573" +
        "000a0303020b0c0503010001071302066d656d6f72790200065f7374617274000e0a9d02" +
        "021400411020003a0000410141084101411810001a0b850201017f410341004120410541" +
        "014200420041004180011002100d41034100412041054108420042004100418001100210" +
        "0d4103410041204105410042c000420041004180011002100d4103412841051003100d41" +
        "03412041051004100d4103412041054103413041051005100d4103413841031006100d41" +
        "034100412041054103413041051007100d41c0004101410341c80041051008100d410341" +
        "00412041054200420041001009100d410341004120410541004202420041004180011002" +
        "100d4180012802002100200042004201100a100d20004200100b100d2000420042004100" +
        "100c100d2000418801410141181000100d20004188014101420041181001100d0b0b5508" +
        "0041080b0810000000010000000041200b057372632f610041280b057372632f64004130" +
        "0b057372632f620041380b037372630041c0000b01610041c8000b057372632f6c004188" +
        "010b09900000000100000079",
    ),
  },
};
