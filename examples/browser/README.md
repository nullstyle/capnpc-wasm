# Schema Studio

A browser workbench for editing Cap’n Proto schemas and generating C++, Rust,
Go, and Zig with the real Wasm compiler and generators.

From the repository root:

```sh
mise run example:browser
# Open http://127.0.0.1:8080/
```

The old `/examples/browser/` URL redirects to Studio. If port 8080 is occupied,
build once and serve on another port:

```sh
mise run build:studio
mise exec -- deno run --allow-read=dist/studio --allow-net=127.0.0.1:8081 scripts/serve-example.ts 8081
```

Studio needs a browser with standardized WebAssembly exception handling
(`exnref`): approximately Chrome 137, Firefox 131, Safari 18.4, or newer. It
checks with the SDK's `supportsWasmExceptions()` at startup and shows an
unsupported-browser message instead of a failed job. The pinned engines the
suite runs in are listed in the [browser guide](../../tests/browser/README.md).

## Working with schemas

Studio opens with a two-file chat protocol and generated C++ output. The other
examples cover telemetry and a key-value service. Edit schemas with syntax
highlighting, line numbers, undo/redo, search, and `Cmd/Ctrl+Enter` to generate.
The divider between the editors supports dragging and arrow keys and stores only
the split, so the sidebar keeps following the responsive breakpoints. Small
screens stack the workspace and editors vertically, keep the status line
visible, and scroll to the result or the error after Generate.

Use **Import files** for a flat selection or **Open folder** to preserve
relative paths. A `.zip` chosen through Import files is expanded in the browser
(one shared top-level folder is stripped, as for a picked folder), so a saved
workspace opens again. Hidden entries, that is dot-prefixed names such as
`.git/` or `.DS_Store` and `__MACOSX/`, are skipped in both modes and counted in
the status line. Importing replaces the workspace; modified workspaces require
confirmation first. Binary assets remain bytes and have a read-only hex preview.
Workspaces are limited to 128 files, 8 MiB, and 512 files and folders combined;
the compiler's own budget is that plus the bundled includes, so anything the
sidebar accepts can compile. Add, rename, and delete files in the sidebar;
renaming does not rewrite imports. A new `.capnp` file starts with a fresh id
and the C++ and Go annotations derived from the file shown when it was added, so
Go and **Generate all** work on it at once.

Checked `.capnp` files are compilation entrypoints: each receives generated
output. Other workspace files remain available to relative imports and embeds.
Standard Cap’n Proto and Go include schemas are bundled. Files under `include/`
provide custom absolute imports: `include/company/types.capnp` is available as
`import "/company/types.capnp"`. Go generation requires the upstream Go package
and import annotations; all bundled examples supply them.

Selecting another language reuses the compiled request if every workspace file
and the entrypoint selection are unchanged. Language tabs use manual activation:
arrow keys move focus, Enter or Space selects. **Generate all** produces all
four targets atomically. A workspace edit clears previous output immediately,
and results or failures arriving from an older snapshot cannot overwrite current
state. Editing during a run keeps Generate available: using it stops the
obsolete job and starts over with the latest edits. Compiler diagnostics retain
the original upstream text, shown under a header with the SDK's failure message,
which names the stage and whether the guest exited, trapped, or hit a resource
budget; a stderr cut-off is marked. Cancel terminates running guest execution,
including a worker that is still starting; a later job starts a fresh worker.

**Save workspace** downloads source files as a ZIP, preserving folders and
binary assets. **Download outputs.zip** includes all languages generated for the
current workspace, each in its own directory. Individual output files can also
be copied or downloaded. Downloads do not prove a file was saved, so modified
workspaces retain the close/replace warning. Files live only in the current tab;
there is no cloud workspace or automatic browser persistence.

## Build and integration

`mise run build:studio` creates a complete static website under `dist/studio/`.
The build stages the site under `dist/studio/.staging` and moves it into place
only after the bundle, the license inventory, and the Content-Security-Policy
hash check succeed, so a failed build leaves the previous site intact. Every
asset URL carries a content hash of the built site (`main.js?v=…`, the worker,
the modules, and the includes), so a redeploy behind an HTTP cache can never mix
one build's `main.js` with another's worker or generators. Only the five modules
Studio loads are shipped; `capnpc-capnp.wasm` is not. The header links to
`assets/licenses/index.html`, an index of every bundled license.

Serve that directory over HTTP(S), including its `assets/` tree. Asset URLs are
relative, so the same directory can be hosted below a path prefix. The server
only serves static files; schemas and compilation results are processed locally.
The compiler and initially selected generator load first. Other generators load
on demand: one worker holds the compiler and every generator requested so far,
and it is replaced only when a new language is needed, so switching between
loaded languages never rebuilds a worker or fetches a module again. Studio keeps
its copy of a module only while the worker could still grow (growing needs every
module again); once all four languages are loaded the copies are released and
each module's bytes are held once, inside the SDK client. Runtime assets and the
editor do not use a CDN.

`index.html` carries its Content-Security-Policy in a meta tag, so any static
host applies it: scripts from the origin only (plus a hash for the one inline
boot script and `'wasm-unsafe-eval'` for the worker's module compilation),
workers from the origin or a blob URL, connections to the origin, inline styles
for the editor, and no objects, base URLs, or foreign form targets. The build
fails if the inline script changes without its hash. `scripts/serve-example.ts`
adds what a meta tag cannot carry: `frame-ancestors 'none'` with
`X-Frame-Options`, `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`, and
`X-Content-Type-Options: nosniff`. It answers only loopback `Host` names (421
otherwise) and never serves dot-prefixed paths. Send the same headers from any
other host.

CodeMirror and the ZIP codec are pinned in `deno.json` and `deno.lock` here. The
build bundles their code and stages their licenses alongside the SDK and
upstream licenses. The app uses the public worker SDK without changing its API.
It generates source code; compiling applications from that source still uses the
matching language toolchain and runtime.

## Structure and tests

`state.js` holds the workspace and job rules as pure functions with `@ts-check`
and JSDoc types (file transitions, entrypoints, revisions, result bookkeeping,
tab navigation, and the new-file template); `workspace.js` holds paths, limits,
imports, and archives; `compiler.js` owns the worker client; `main.js` binds the
DOM. Unit tests run without a browser:

```sh
mise run test:studio-unit
```

Run browser coverage from the repository root:

```sh
mise run test:studio
# Or select an engine:
mise run test:studio chromium
```

The Studio driver is separate from the SDK's offline permission-revoking driver.
It exercises the actual page under its Content-Security-Policy, compares
downloaded C++/Rust/Go/Zig output with fresh native output, and checks editing,
undo across file changes, the new-file template with Generate all, the failure
header, cancellation (asserting the cancelled state) and recovery, a 503 on a
generator asset, a keyboard-only flow that asserts `document.activeElement`,
imports including a ZIP round trip and a folder with `.git/` and `.DS_Store`,
file management, the unsupported-engine state, the resize handle across
breakpoints, and narrow/enlarged-text layouts. It also runs the pinned axe-core
(`4.13.0`, MPL-2.0, served from the test origin) against the initial, generated,
and phone-width states with the WCAG 2.0, 2.1, and 2.2 A and AA rules and fails
on any violation. Receipts, axe results, and screenshots are written under
`build/test/studio-*/`. The browser CI job runs both suites in Chromium,
Firefox, and WebKit.
