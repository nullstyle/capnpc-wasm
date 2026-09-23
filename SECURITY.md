# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's private vulnerability
reporting for this repository:
<https://github.com/nullstyle/capnpc-wasm/security/advisories/new>. Use that
channel rather than a public issue or pull request, so a fix and new archive
digests can be prepared before details are public. If the advisory form is
unavailable, open a public issue that says only that you have a security report
and how to reach you privately; do not include details.

Include the archive name and version (or the commit), the host you used (the
launcher with its Wasmtime version, the Deno version, the browser, or the Go
SDK), the schema or request that triggers the problem, and what you observed.
Problems that turn out to be in an upstream component (Cap'n Proto,
capnproto-rust, go-capnp, capnp-zig, wazero, browser_wasi_shim, Wasmtime) are
forwarded upstream after triage. The pinned revisions are the gitlinks under
`ref/` (mapped in [ref/README.md](ref/README.md); `mise run refs:status` prints
them) and the Wasmtime pin in `mise.toml`.

This is a single-maintainer project. Responses are best effort; there is no
security team, service-level commitment, or bounty program.

## Supported versions

Published assets are immutable. A fix ships as a new version whose digests are
added to [published releases](docs/releases.md#published-releases).

| Artifact                                  | Receives fixes                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `capnp-wasm-tools`                        | `0.1.0-rc.2` (published) and `main`                                     |
| `capnp-wasm-compiler-host`                | `0.1.0-rc.3` (published) and `main`; rc.2 stays available but unchanged |
| `capnpc-wasm` full SDK archive, Go module | Unreleased; `main` only                                                 |

## Scope

The [threat model](docs/threat-model.md) states the trust boundaries. Within
them, the following are vulnerabilities:

- A guest reading or writing outside its staged workspace or output root,
  spawning a process, or reaching the network through any host this project
  ships (TypeScript SDK, Go SDK, packaged launcher).
- Host resource exhaustion that bypasses a documented limit.
- Generated output or diagnostics escaping the documented publication rules, for
  example partial output published after a failed generator in an SDK.
- A way to make a tampered archive pass `verify-release.ts` and the recorded
  digests.

Long-running compilation of a legitimately large schema on the direct TypeScript
path is a documented limitation (that path has no deadline), and the threat
model lists further known gaps that are already tracked.
