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

## Working with schemas

Studio opens with a two-file chat protocol and generated C++ output. The other
examples cover telemetry and a key-value service. Edit schemas with syntax
highlighting, line numbers, undo/redo, search, and `Cmd/Ctrl+Enter` to generate.
The divider between the editors supports dragging and arrow keys. Small screens
stack the workspace and editors vertically.

Use **Import files** for a flat selection or **Open folder** to preserve
relative paths. Importing replaces the workspace; modified workspaces require
confirmation first. Binary assets remain bytes and have a read-only hex preview.
Workspaces are limited to 128 files and 8 MiB. Add, rename, and delete files in
the sidebar; renaming does not rewrite imports.

Checked `.capnp` files are compilation entrypoints: each receives generated
output. Other workspace files remain available to relative imports and embeds.
Standard Cap’n Proto and Go include schemas are bundled. Files under `include/`
provide custom absolute imports: `include/company/types.capnp` is available as
`import "/company/types.capnp"`. Go generation requires the upstream Go package
and import annotations; all bundled examples supply them.

Selecting another language reuses the compiled request if every workspace file
and the entrypoint selection are unchanged. **Generate all** produces all four
targets atomically. A workspace edit clears previous output immediately, and
results or failures arriving from an older snapshot cannot overwrite current
state. Compiler diagnostics retain the original upstream text. Cancel terminates
running guest execution; a later job can restart the worker. Initial module
compilation uses the SDK's bounded initialization deadline, with at most one
pending initialization even across repeated cancellations.

**Save workspace** downloads source files as a ZIP, preserving folders and
binary assets. **Download outputs.zip** includes all languages generated for the
current workspace, each in its own directory. Individual output files can also
be copied or downloaded. Downloads do not prove a file was saved, so modified
workspaces retain the close/replace warning. Files live only in the current tab;
there is no cloud workspace or automatic browser persistence.

## Build and integration

`mise run build:studio` creates a complete static website under `dist/studio/`.
Serve that directory over HTTP(S), including its `assets/` tree. Asset URLs are
relative, so the same directory can be hosted below a path prefix. The server
only serves static files; schemas and compilation results are processed locally.
The compiler and initially selected generator load first. Other generators load
on demand, with bytes retained for reuse during the session. Runtime assets and
the editor do not use a CDN.

CodeMirror and the ZIP encoder are pinned in `deno.json` and `deno.lock` here.
The build bundles their code and stages their licenses alongside the SDK and
upstream licenses. The app uses the public worker SDK without changing its API.
It generates source code; compiling applications from that source still uses the
matching language toolchain and runtime.

Run browser coverage from the repository root:

```sh
mise run test:studio
# Or select an engine:
mise run test:studio chromium
```

The Studio driver is separate from the SDK's offline permission-revoking driver.
It exercises the actual page, compares downloaded C++/Rust/Go/Zig output with
fresh native output, checks editing and diagnostics, cancellation/recovery,
imports and binary ZIP exports, file management, and narrow/enlarged-text
layouts. Receipts and screenshots are written under `build/test/studio-*/`. The
browser CI job runs both suites in Chromium, Firefox, and WebKit.
