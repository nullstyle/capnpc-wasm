# Release confidence

The first candidate is `0.1.0-rc.1`. It is private and has not been published.
Project licensing is still awaiting the owner's choice; candidate metadata uses
`UNLICENSED` until then, with upstream licenses retained separately.

The Zig generator and runtime now come directly from the pristine pinned
capnp-zig commit. Eight local patches and three copied reflection files have
been removed. The synchronization gate checks all 194 current source files and
35 mirrored conformance fixtures. The old audit source is independently pinned,
exported, and verified so its failing writer and traversal controls remain
available after a live reference update. Injected historical-source drift was
rejected by the gate.

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

The package gate checks reproducible archive bytes, SHA-256 inventory integrity,
stale staging cleanup, and tamper rejection. External Deno consumers exercise
the npm-layout package's direct, replay, and worker APIs; an external Go module
uses the exact public wazero dependency without a local runtime replacement.
Both SDKs generate identical C++, Rust, Go, and Zig bytes. The final receipt is
written to `build/test/package-receipt.json` and identifies the source commit,
dirty state, source digest, and archive digest. Rebuild after committing to tie
the candidate to a clean source revision.

Seven consecutive successful scheduled native Nightly runs remain an elapsed
time gate. Local tests and manual Nightly runs do not count as daily cycles. The
release-confidence follow-up checks daily at 05:00 America/Anchorage, records
exact run evidence, and reports actionable failures or completion. Relevant
runtime, generator, test, dependency, or gate changes restart the qualifying
streak. Publication additionally requires a license choice and an explicit
release decision.
