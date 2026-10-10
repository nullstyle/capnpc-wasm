#!/usr/bin/env bash
#
# Check that every download URL recorded in mise.lock is still served, so that
# upstream pruning is caught by the nightly workflow before a cold bootstrap
# fails. For a Zig tarball from ziglang.org, and any entry that records minisign
# provenance, the .minisig beside the URL is checked too: core:zig downloads
# and verifies it on every install, and `mise lock zig` records no provenance.
# Exit status 1 when any file is unavailable.
#
# The pinned Zig is a tagged release from ziglang.org, which keeps tagged
# releases; a ziglang.org/builds/ URL names a development build, which
# ziglang.org deletes within weeks, so the hint below says to pin a tag.
#
# Usage: bash scripts/check-lock-urls.sh [mise.lock]
set -euo pipefail

lock="${1:-mise.lock}"

status_of() {
  # HEAD first; hosts that reject HEAD get a one-byte ranged GET.
  local url="$1" code
  code="$(curl -sS -I -L --retry 2 --retry-delay 3 --max-time "${CHECK_LOCK_URLS_TIMEOUT:-30}" -o /dev/null -w '%{http_code}' "$url" 2> /dev/null || echo 000)"
  case "$code" in
    2*) ;;
    403 | 405 | 501)
      code="$(curl -sS -L -r 0-0 --retry 2 --retry-delay 3 --max-time "${CHECK_LOCK_URLS_TIMEOUT:-30}" -o /dev/null -w '%{http_code}' "$url" 2> /dev/null || echo 000)"
      ;;
  esac
  printf '%s\n' "$code"
}

annotate() {
  # usage: annotate <warning|error> <message>; a GitHub Actions annotation
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    printf '::%s::%s\n' "$1" "$2"
  fi
}

# One line per lock entry that records a URL: "<url><TAB><provenance>".
entries() {
  awk '
    function flush() {
      if (url != "") print url "\t" provenance
      url = ""; provenance = ""
    }
    /^\[/ { flush(); next }
    /^url = "/ { url = $0; sub(/^url = "/, "", url); sub(/"$/, "", url); next }
    /^provenance = "/ { provenance = $0; sub(/^provenance = "/, "", provenance); sub(/"$/, "", provenance); next }
    END { flush() }
  ' "$1" | sort -u
}

served=0
signatures=0
failed=0
report=""

fail() {
  failed=$((failed + 1))
  echo "FAIL $1"
  annotate error "$1"
  report="$report"$'\n'"- FAIL $1"
}

while IFS=$'\t' read -r url provenance; do
  [[ -n "$url" ]] || continue
  code="$(status_of "$url")"
  if [[ "$code" != 2* ]]; then
    hint=""
    if [[ "$url" == https://ziglang.org/builds/* ]]; then
      hint="; ziglang.org deletes development builds: pin a tagged Zig release (CONTRIBUTING.md, Tool pins)"
    fi
    fail "$url returned HTTP $code$hint"
    continue
  fi
  served=$((served + 1))
  if [[ "$provenance" == minisign || "$url" == https://ziglang.org/* ]]; then
    code="$(status_of "$url.minisig")"
    if [[ "$code" == 2* ]]; then
      signatures=$((signatures + 1))
    else
      fail "$url.minisig returned HTTP $code; mise verifies it on every install"
    fi
  fi
done <<< "$(entries "$lock")"

summary="$served locked URLs served ($signatures with their .minisig), $failed unavailable ($lock)"
echo "$summary"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '### Locked download URLs\n\n%s\n%s\n' "$summary" "$report" >> "$GITHUB_STEP_SUMMARY"
fi
((failed == 0))
