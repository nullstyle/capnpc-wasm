# WASI SDK 34 runtime notices

The `capnp.wasm`, `capnpc-c++.wasm`, and `capnpc-capnp.wasm` modules link the
WASI SDK 34 sysroot: wasi-libc (with its musl, cloudlibc, dlmalloc, and musl-fts
portions) and LLVM's libc++, libc++abi, libunwind, and compiler-rt builtins. The
SDK release archive ships those libraries without their license texts, and
`ref/wasi-sdk` records the source trees only as nested submodules that
`mise run refs:sync` leaves uninitialized (a recursive checkout would fetch
LLVM). This directory holds the texts at exactly the commits `ref/wasi-sdk`
records, so `scripts/package-assets.ts` can stage them into every archive's
`licenses/` directory offline.

`manifest.json` names each source repository, the gitlink path inside
`ref/wasi-sdk`, the commit, and the SHA-256 of every file. `package-assets.ts`
fails when the `wasi-sdk` pin in `mise.toml` differs from the manifest's `sdk`,
when `git -C ref/wasi-sdk rev-parse HEAD:<gitlink>` differs from the manifest's
commit, or when a file's digest differs.

## Refreshing after a WASI SDK bump

1. Read the new nested commits:
   `git -C ref/wasi-sdk rev-parse HEAD:src/wasi-libc HEAD:src/llvm-project`.
2. Fetch each file listed in `manifest.json` from those commits, for example
   `https://raw.githubusercontent.com/WebAssembly/wasi-libc/<commit>/LICENSE`
   and
   `https://raw.githubusercontent.com/llvm/llvm-project/<commit>/libcxx/LICENSE.TXT`,
   and check wasi-libc's top-level `LICENSE` for portions that gained or lost
   their own notice file.
3. Rename the directory to the new SDK version, update `sdk`, the commits, and
   the digests in `manifest.json` (`shasum -a 256`), and the paths in
   `scripts/package-assets.ts`.
4. Run `mise run build:sdk` and `mise run test:package`.
