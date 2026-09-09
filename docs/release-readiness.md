# Release confidence

The first candidate is `0.1.0-rc.1`. It is private and has not been published.
Project-owned code and SDKs are licensed under Apache-2.0, with upstream
licenses retained separately. The root and nested Go module both include the
project license, and the package gate verifies the extracted license files.

The Zig generator and runtime now come directly from the pristine pinned
capnp-zig commit. Eight local patches and three copied reflection files have
been removed. The synchronization gate checks all 194 current source files and
36 mirrored conformance fixtures. The old audit source is independently pinned,
exported, and verified so its failing writer and traversal controls remain
available after a live reference update. Injected historical-source drift was
rejected by the gate.

The native transport follow-up fixes pending-accept shutdown on Windows and
retains completed TCP receive bytes when deadlines or cancellation race a read.
It also corrects QUIC test teardown ownership. Native verification is tracked in
[CI 34309834241](https://github.com/nullstyle/capnp-zig/actions/runs/34309834241)
and the separate
[manual Nightly 34309838621](https://github.com/nullstyle/capnp-zig/actions/runs/34309838621).
The synchronized Zig Wasm generator bytes are unchanged by those transport
fixes.

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
engines and their system libraries, then requires all three engines to pass.

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
[Browser evidence](../tests/browser/README.md) records the control and
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
time gate. Local tests and manual Nightly runs do not count as daily cycles. The
release-confidence follow-up checks daily at 05:00 America/Anchorage, records
exact run evidence, and reports actionable failures or completion. Relevant
runtime, generator, test, dependency, or gate changes restart the qualifying
streak. Publication additionally requires an explicit release decision.
