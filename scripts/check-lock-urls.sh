#!/usr/bin/env bash
#
# Check that every download URL recorded in mise.lock is still served, so that
# upstream pruning is caught by the nightly workflow before a cold bootstrap
# fails. For an entry that requires minisign provenance (the pinned Zig), the
# .minisig beside the URL is checked too: mise verifies it on every install.
# Exit status 1 when any file is unavailable.
#
# The Zig entries name the project's mirror release, the URLs that mise.toml's
# url_replacements rule sends core:zig to, with the community mirrors off. A
# ziglang.org build URL in the lock is a regression (`mise lock zig` writes
# one): mise would request it, and ziglang.org prunes development builds.
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
      hint="; the pinned Zig comes from the project's mirror release: run \`mise run mirror:zig -- lock --write\`"
    fi
    fail "$url returned HTTP $code$hint"
    continue
  fi
  served=$((served + 1))
  if [[ "$provenance" == minisign ]]; then
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
