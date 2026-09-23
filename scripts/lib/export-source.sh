#!/usr/bin/env bash
# shellcheck shell=bash
#
# Staged, verified export of committed reference sources into build/src.
# Sourced by the build scripts; requires `set -euo pipefail` in the caller.
#
# ensure_source_export <ref dir> <revision> <destination> <key> <patch> [path...]
#   Reuses <destination> while its .source-key equals <key> and its content
#   digest still matches the .source-digest written at export time. Otherwise
#   (including after an edit inside the exported copy) it exports again:
#   `git archive` writes a tar file first, because BSD tar in a pipe can close
#   early and turn the harmless SIGPIPE into a pipefail failure; the tar is
#   extracted into a temporary sibling directory, <patch> (empty for none) is
#   applied there, the key and digest are written, and the tree is moved into
#   place in one step. <path...> limits the archive to those tree paths.

source_digest() {
  # SHA-256 over the sorted list of per-file digests below a directory,
  # excluding the export metadata files.
  local sum
  if command -v sha256sum > /dev/null 2>&1; then
    sum=(sha256sum)
  else
    sum=(shasum -a 256)
  fi
  (
    cd "$1" &&
      find . -type f ! -name .source-key ! -name .source-digest -print0 |
      LC_ALL=C sort -z | xargs -0 "${sum[@]}" | "${sum[@]}" | cut -d ' ' -f 1
  )
}

export_source() (
  local ref_dir="$1" revision="$2" destination="$3" key="$4" patch="$5" staging
  shift 5
  mkdir -p "$(dirname "$destination")"
  staging="$(mktemp -d "$(dirname "$destination")/.export.XXXXXX")"
  trap 'rm -rf "$staging"' EXIT
  git -C "$ref_dir" archive --format=tar --output="$PWD/$staging/source.tar" \
    "$revision" "$@"
  mkdir "$staging/source"
  tar -xf "$staging/source.tar" -C "$staging/source"
  rm -f "$staging/source.tar"
  if [[ -n "$patch" ]]; then
    git apply --check --directory="$staging/source" "$patch"
    git apply --directory="$staging/source" "$patch"
  fi
  printf '%s\n' "$key" > "$staging/source/.source-key"
  source_digest "$staging/source" > "$staging/source/.source-digest"
  rm -rf "$destination"
  mv "$staging/source" "$destination"
)

ensure_source_export() {
  local destination="$3" key="$4"
  if [[ -f "$destination/.source-key" ]] &&
     [[ "$(cat "$destination/.source-key")" == "$key" ]]; then
    if [[ ! -f "$destination/.source-digest" ]]; then
      echo "$destination has no content digest; exporting it again" >&2
    elif [[ "$(source_digest "$destination")" == "$(cat "$destination/.source-digest")" ]]; then
      return 0
    else
      echo "warning: $destination was modified after its export; exporting it again" >&2
    fi
  fi
  export_source "$@"
}
