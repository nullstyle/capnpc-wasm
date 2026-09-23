# Release confidence narrative (September 2026)

> Historical document. This narrative was frozen at commit `b8d8e3f`
> (2026-09-09) and moved here on 2026-09-22 with only its title, this banner,
> and relative link paths changed. Its status statements describe that date: the
> SDK candidate was `0.1.0-rc.1` and nothing had been published. Current gate
> status lives in [release readiness](../release-readiness.md); published
> archives are listed in the [release guide](../releases.md).

The first candidate is `0.1.0-rc.1`. It is private and has not been published.
Project-owned code and SDKs are licensed under Apache-2.0, with upstream
licenses retained separately. The root and nested Go module both include the
project license, and the package gate verifies the extracted license files.

Initial hosted acceptance passed on September 9, 2026: native `0fb8df4`, Wasm
`94ba6b2`, and Deno `24ccd29` have successful CI runs, and the native manual
Nightly passed every job. The
[run inventory](../release-evidence/initial-hosted-checks.json) records exact
revisions and every successful job. The
[confidence ledger](../release-evidence/nightly-confidence.json) records one of
seven required consecutive scheduled daily Nightly successes.

The first qualifying
[scheduled run, September 9](https://github.com/nullstyle/capnp-zig/actions/runs/34334866428),
passed all five jobs at native `0fb8df4`. Its
[hosted execution receipt](../release-evidence/nightly-2026-09-09-hosted.json)
preserves every job and step plus execution summaries and raw-log hashes. The
[fuzz audit](../release-evidence/nightly-2026-09-09-fuzz.json) verifies all 17
source-discovered targets, 180,296 executions, at least 10,005 per target
against the 10,000 floor, zero process failures, and all five harness
self-checks. This run used the `schedule` event; the earlier manual runs remain
nonqualifying.

The Zig generator and runtime now come directly from the pristine pinned
capnp-zig commit. Eight local patches and three copied reflection files have
been removed. The synchronization gate checks all 194 current source files and
36 mirrored conformance fixtures. The old audit source is independently pinned,
exported, and verified so its failing writer and traversal controls remain
available after a live reference update. Injected historical-source drift was
rejected by the gate.

The native transport follow-up fixes pending-accept shutdown on Windows and
retains completed TCP receive bytes when deadlines or cancellation race a read.
It also corrects QUIC test teardown ownership. The first native candidate,
`b547490`, failed the Windows Debug and ReleaseSafe full suites in
[CI 34309834241](https://github.com/nullstyle/capnp-zig/actions/runs/34309834241).
Focused Windows probes isolated a stale rejected-operation slot followed by an
indefinite wait before receive cancellation. The separate
[manual Nightly 34309838621](https://github.com/nullstyle/capnp-zig/actions/runs/34309838621)
passed, including all 17 fuzz targets with 179,606 total executions; the
[per-target receipt](../release-evidence/b547490-manual-nightly.json) preserves
source hashes, iteration counts, and exit status. That manual run and its
successful Windows soaks do not substitute for timed-read execution or count as
a scheduled daily confidence cycle. The synchronized Zig Wasm generator bytes
are unchanged by those transport fixes.

The synchronized follow-up at native `c875835` repairs both timed-read defects.
Its runtime and tests match the successful
[Windows probe 34314807091](https://github.com/nullstyle/capnp-zig/actions/runs/34314807091):
all eight timed-read cases ran in Debug and ReleaseSafe with zero skips.
Removing only the cancellation wake reproduced consumption of fourteen bytes
arriving after the deadline in both modes; the repaired reads returned Timeout
and preserved those bytes for the next read. The main CI now runs a named,
bounded Windows timed-read executable before each full suite and preserves
process diagnostics. Local Debug and ReleaseSafe transport suites each passed 53
tests, with unchanged public API snapshots and a passing hardening gate. Full
integration evidence is tracked in
[CI 34315133881](https://github.com/nullstyle/capnp-zig/actions/runs/34315133881)
and the fresh
[manual Nightly 34315154577](https://github.com/nullstyle/capnp-zig/actions/runs/34315154577).
The manual Nightly passed all five jobs. Its
[per-target receipt](../release-evidence/c875835-manual-nightly.json) records
180,345 executions across all 17 discovered fuzz targets, with each exceeding
10,000 executions and matching the exact source and raw report identity. It is a
manual run and does not count toward the daily streak.

The earlier `c875835` native CI passed 24 of 25 jobs, including the Windows
Debug full suite and both focused Windows timed-read gates. The remaining
Windows ReleaseSafe job failed with an inactive Zig test-runner response
timeout. Its original log does not identify the protocol phase or establish that
a named teardown test hung. Both unchanged teardown callbacks passed repeated
terminal, direct-protocol, and actual Maker execution in
[probe 34319397598](https://github.com/nullstyle/capnp-zig/actions/runs/34319397598).

Subsequent Windows probes isolated a pinned Zig process-inheritance defect:
concurrently created child processes can retain each other's output-pipe
handles. In
[actual Maker probe 34320712747](https://github.com/nullstyle/capnp-zig/actions/runs/34320712747),
14 Debug and 16 ReleaseSafe runners hit the unchanged 60-second response limit
with all tests passed and their own processes already exited zero, while sibling
processes kept their pipes open. Both serial controls passed all 16 tests and 37
build steps. The
[verified evidence receipt](../release-evidence/windows-maker-inheritance.json)
records exact source, artifact and raw-receipt hashes, process/pipe
observations, and the limitation that the original c875835 process state was not
captured.

Native `04d3b62` applies the project-owned workaround; the follow-up `0fb8df4`
is synchronized in this Wasm candidate. It compiles each selected suite's exact
prerequisites in parallel, waits for that invocation to exit, then runs the
unchanged suite with one Maker job on Windows. It preserves test selection,
test-internal concurrency, skip policy, time limits, and failure propagation.
The original runtime, generator and test sources remain unchanged. The full
Windows Debug, ReleaseSafe, ReleaseFast and QUIC gates have now passed with the
workaround. The first
[native CI 34324587356](https://github.com/nullstyle/capnp-zig/actions/runs/34324587356)
rejected the new compile step's display label under the existing ReleaseFast
policy scanner. `0fb8df4` removes the incidental mode word from that label;
commands and policy exceptions are unchanged, and local hardening passes with 72
reviewed findings across 195 files. The
[manual Nightly at 04d3b62](https://github.com/nullstyle/capnp-zig/actions/runs/34324612439)
passed all five jobs; it remains nonqualifying manual evidence. The final
[native CI 34325581790](https://github.com/nullstyle/capnp-zig/actions/runs/34325581790)
passed all 25 jobs, and
[manual Nightly 34325616792](https://github.com/nullstyle/capnp-zig/actions/runs/34325616792)
passed all five. Its
[audited fuzz receipt](../release-evidence/0fb8df4-manual-nightly.json) verifies
all 17 source-discovered targets, 180,533 executions, at least 10,005 per
target, zero process failures, and all five harness self-checks. This manual run
does not count toward the scheduled daily streak.

[Windows execution evidence](../release-evidence/0fb8df4-windows-ci.json)
records 1,999/2,002 Debug and 1,998/2,002 ReleaseSafe full-suite passes. The
three common skips are the existing Windows symlink-output and idle-traffic
timing guards; ReleaseSafe additionally skips the Debug-only thread-affinity
observation. ReleaseFast passed 168/169 tests with that same Debug-only skip.
Both QUIC modes passed 88/88 tests without skips, and both focused timed-read
gates ran all eight regression cases without skips or timeouts. Parallel
compilation took 7m37s for Debug and 27m40s for ReleaseSafe; serial execution
took 5m28s and 4m05s respectively. The entire ReleaseSafe/ReleaseFast job
finished in 39m27s, within its unchanged 45-minute limit.

The local compile/run phases passed: Debug ran 1,786/1,786 tests; ReleaseSafe
ran 1,785/1,786 with the existing Debug-only test skipped. Both completed all
199 build steps. A comparison of real build configurations verified that all
original execution nodes and flags were unchanged, and all three warmups
retained exactly the corresponding compile/failure prerequisites with no
test-runner execution. Formatting, workflow lint, and an independent
command/graph review also passed.

The TypeScript SDK now bounds guest linear memory and the bytes/counts used for
workspaces, requests, outputs, stdout, and stderr. It requires original Wasm
bytes to enforce memory ceilings. These are explicit per-workspace and
per-command bounds, not a total JavaScript heap limit. Worker restarts preserve
the chosen limits, and failed compilations/generations publish no partial
output. Tests include exact boundaries, sparse writes, retained inodes,
descriptor renumbering, and resizable-buffer growth. Independent review
reproduced and fixed an in-place buffer-growth accounting escape before final
packaging.

Browser tests run Chromium, Firefox, and WebKit in separate processes with
network/process permissions revoked after setup. The parent compares complete
canonical requests with native output. Generic RPC and streaming schemas join
the feature corpus, and direct/worker resource failures, memory-growth ceilings,
cancellation, and recovery run in each engine.

Hosted CI starts from clean Linux and macOS checkouts and runs `mise run check`
and `mise run test:package`. A separate Linux job installs the pinned browser
engines and their system libraries, then requires all three engines to pass. The
Apache-2.0 candidate `0b4bbf6` passed every job in
[Wasm CI 34311506597](https://github.com/nullstyle/capnpc-wasm/actions/runs/34311506597).
The synchronized candidate `894890b` also passed every job in
[Wasm CI 34315464935](https://github.com/nullstyle/capnpc-wasm/actions/runs/34315464935).
Schema Studio at `a2326f6` passed all three jobs in
[Wasm CI 34317631265](https://github.com/nullstyle/capnpc-wasm/actions/runs/34317631265),
including the new Studio workflows in Chromium, Firefox, and WebKit. The
subsequent evidence-only revision `bee74ef` also passed all three jobs in
[Wasm CI 34319492314](https://github.com/nullstyle/capnpc-wasm/actions/runs/34319492314).
Studio's local tests compare downloaded files with native C++/Rust/Go/Zig output
and exercise folder imports, binary assets, diagnostics, cancellation, and stale
results. The public SDK API, native runtime, generators, and reference pins are
unchanged. A fresh clean-source
[private package receipt](../release-evidence/a2326f6-private-package.json)
records package verification at that exact revision, including external Deno and
Go consumers, byte parity, licensing, reproducibility, and tamper rejection.

The synchronized candidate `94ba6b2` passed every job in
[Wasm CI 34325732963](https://github.com/nullstyle/capnpc-wasm/actions/runs/34325732963),
including all three browser engines and clean Linux/macOS package consumers. Its
[clean private package receipt](../release-evidence/94ba6b2-private-package.json)
identifies the accepted source and archive hashes. The complete Zig source
inventory and generator Wasm bytes remain unchanged by the build workaround.

The companion capnp-deno schema-evolution and transport-closure repairs at
`24ccd29` passed every job in
[Deno CI 34312400044](https://github.com/nullstyle/capnp-deno/actions/runs/34312400044)
on attempt 2, after retrying an HTTP 500 during the benchmark job's tool setup.

The first hosted run,
[34306671510](https://github.com/nullstyle/capnpc-wasm/actions/runs/34306671510),
passed the clean Linux and macOS checks and external package consumers on
`ac9b91e`. Chromium and Firefox passed. WebKit trapped while compiling after a
worker timeout; the exact trap has not reproduced locally, including a complete
Linux browser run. The subsequent hosted browser matrix passed on `92d55f3`.
Independent repeated cancellation did expose an older-engine stall: unchanged
SDK/Wasm bytes stalled after 9 cycles with WebKit revision 2248 and after 17
with revision 2311, while revision 2359 passed 100 cycles. This evidence
supports the Playwright 1.63.0 upgrade without establishing the cause of the
earlier hosted null-reference trap. The browser gate now verifies twenty
alternating cancellations and complete output recovery per engine. The narrow
Deno bootstrap compatibility test preserves denied procfs access; no runtime
permission is added. The updated macOS three-engine matrix and complete Linux
WebKit suite, including canonical request verification, passed locally.
[Browser evidence](../../tests/browser/README.md) records the control and
reproduction commands. Subsequent failing jobs retain their exact Wasm modules
and SDK bundles alongside fixtures for investigation.

The package gate checks reproducible archive bytes, SHA-256 inventory integrity,
stale staging cleanup, and tamper rejection. External Deno consumers exercise
the npm-layout package's strict TypeScript declarations and direct, replay, and
worker APIs; an external Go module uses the exact public wazero dependency
without a local runtime replacement. Both SDKs generate identical C++, Rust, Go,
and Zig bytes. The final receipt is written to `build/test/package-receipt.json`
and identifies the source commit, dirty state, source digest, and archive
digest. Rebuild after committing to tie the candidate to a clean source
revision.

Seven consecutive successful scheduled native Nightly runs remain an elapsed
time gate, with one qualifying cycle recorded and six more required. Local tests
and manual Nightly runs do not count as daily cycles. The release-confidence
follow-up runs daily at 05:00 America/Anchorage. The native workflow is
scheduled for 09:17 UTC; September 9 is the first eligible scheduled date for
this accepted native revision. The confidence ledger records every counted cycle
and its per-target evidence. A missed or failed cycle resets the consecutive
count. The follow-up reports actionable failures or completion. Relevant
runtime, generator, test, dependency, or gate changes restart the qualifying
streak. Publication additionally requires an explicit release decision.
