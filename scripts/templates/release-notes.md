{{description}}

Built from commit [`{{shortCommit}}`](https://github.com/nullstyle/capnpc-wasm/commit/{{commit}}) (tag `{{tag}}`) by the release workflow.

## Changes

{{changes}}

## Assets

| Asset                   | SHA-256              |
| ----------------------- | -------------------- |
| `{{stem}}.tgz`          | `{{archiveSha256}}`  |
| `{{stem}}.manifest.json` | `{{manifestSha256}}` |
| `{{stem}}.spdx.json`    | `{{sbomSha256}}`     |

`{{stem}}.manifest.json` is the archive's `package/manifest.json`, published separately so that `sha256sum -c SHA256SUMS` passes before extraction. `{{stem}}.spdx.json` is the SPDX 2.3 software bill of materials for the archive.

## Verify

```sh
sha256sum -c SHA256SUMS
gh attestation verify {{stem}}.tgz --repo nullstyle/capnpc-wasm
gh attestation verify {{stem}}.spdx.json --repo nullstyle/capnpc-wasm
tar -xzf {{stem}}.tgz
# In the download directory, with the verifier of a checkout at the tag:
deno run --allow-read /path/to/capnpc-wasm/scripts/verify-release.ts --sums SHA256SUMS \
  --expect-manifest-sha256 {{manifestSha256}} --expect-commit {{commit}} \
  --require-clean ./package
```

The row for this release in [docs/releases.md](https://github.com/nullstyle/capnpc-wasm/blob/main/docs/releases.md#published-releases) records the same digests independently of this page.
