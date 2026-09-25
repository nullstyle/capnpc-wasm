# Shared test harness

The Deno suites under `tests/` import these modules instead of carrying their
own copies of the subprocess, comparison, and directory helpers.

| Module       | Exports                                                                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paths.ts`   | `root`, `nativeBin`, `wasmBin`, `wazeroRun`, `buildTest`, `zigCacheDir`, `zigRuntime`                                                                                                    |
| `process.ts` | `run`, `mustSucceed`, `expectSuccess`, `describeExit`, `decodeText`, `childEnv`, `envGranted`, `envValue`, `ldflags`, `ENV_PASSTHROUGH`, `RunOptions`, `RunResult`, `MustSucceedOptions` |
| `fs.ts`      | `copyTree`, `readTree`, `writeTree`, `asTree`, `Tree`, `TreeLike`                                                                                                                        |
| `assert.ts`  | `assert`, `assertBytesEqual`, `assertTextEqual`, `assertTreesEqual`, `firstDifference`, `hexWindow`, `textOf`, `unifiedDiff`, `treePaths`                                                |
| `workdir.ts` | `testSuite`, `keepTestDirs`, `TestSuite`                                                                                                                                                 |
| `oracle.ts`  | `nativeCompile`, `canonicalRequest`, `stageStandardIncludes`, `normalizeDiagnostic`, `clangxx`, `NativeCompileOptions`, `DiagnosticNormalization`                                        |
| `hosts.ts`   | `wasmHosts`, `guestCommand`, `moduleCommand`, `assertGuestDiagnostic`, `TRAP_TEXT`, `TRAP_GUEST`, `HOST_TRAP_EXIT_CODE`, `WASMTIME_TRAP_EXIT_CODE`, `WasmHost`, `GuestOptions`           |

## Processes and environment

`run` spawns a command with captured binary stdout and stderr, piped bytes
(`stdin`) or a regular file (`stdinFile`) on standard input, and tolerates a
child that exits before reading all of its input. After `timeoutMs` (60 s by
default) the direct child receives SIGTERM, then SIGKILL 5 s later if it ignores
that; once it has exited, `run` stops waiting for stdout and stderr, so a
grandchild that inherited the pipes (a `cargo test` or `zig test` binary) cannot
hold the call open, and the output captured until then is returned with
`timedOut` set. A step that compiles code (a consumer, probe, or oracle build)
passes `buildTimeoutMs`, ten minutes, since cold compiler caches on a loaded
runner outlast the default, and only builds: the program it built then runs as
its own step under the default, so a hung program fails in 60 s and its own
timeout stops it. `mustSucceed` returns stdout and fails with the exit status
and stderr.

Children receive only the variables in `ENV_PASSTHROUGH` plus the explicit `env`
additions. The list must equal `[vars].suite_env` in `mise.toml`, which the
seven suite tasks pass as their `--allow-env` list: it carries `PATH`, `HOME`,
`TMPDIR`, the native compiler selection (`CC`, `CXX`), what
`scripts/lib/toolchain-env.sh` exports when the default macOS SDK cannot link
(`SDKROOT`, or `LDFLAGS` and the host triple's `CARGO_TARGET_*_RUSTFLAGS`), the
mise `[env]` cache locations, and `RUSTUP_TOOLCHAIN`, without which the rustup
proxy would run the user's default toolchain instead of the pinned one. Without
`--allow-env` for the whole list, children inherit the full environment and a
warning is printed once. clang never reads `LDFLAGS`, so suites build every
direct `clang++` command with `clangxx`, which appends the split `LDFLAGS`.

## Work directories

`testSuite(prefix)` gives a suite `workDir()` under `build/test/` and a `test()`
wrapper that records failures, including failed steps. When the process exits,
the suite's directories are deleted if every test passed, kept and printed if
any test failed, and always kept when `CAPNP_KEEP_TEST_DIRS=1` is set.

## Comparisons

`assertBytesEqual` reports the first differing offset with a hex window of both
sides and, for UTF-8 text, a unified diff. `assertTreesEqual` compares two
directories or in-memory file maps and lists missing, extra and changed paths
before showing the first changed file the same way.

## Hosts and the exit-class oracle

`wasmHosts` lists Wasmtime, wazero (compiler and interpreter), and the Deno
browser-shim host; `guestCommand` builds the command line that runs a module
with a staging directory as `/` and the tool name as `argv[0]`.
`assertGuestDiagnostic` accepts only a guest diagnostic: exit status 1, empty
stdout, and stderr without runtime trap text. A trap or an uncaught exception
exits 134 under Wasmtime and 70 under the other hosts, so it can no longer pass
as a diagnostic. `normalizeDiagnostic` strips staging paths, masks generated
ids, and drops native stack lines so Wasm stderr can be compared with native.
