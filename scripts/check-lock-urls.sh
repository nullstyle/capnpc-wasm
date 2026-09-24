#!/usr/bin/env bash
#
# Check that every download URL recorded in mise.lock is still served, so that
# upstream pruning is caught by the nightly workflow before a cold bootstrap
# fails. Exit status 1 when a file is unavailable from every source.
#
# ziglang.org prunes development builds. A ziglang.org URL that is gone passes
# with a warning when at least one Zig community mirror
# (https://ziglang.org/download/community-mirrors.txt) still serves the tarball
# and its .minisig: mise installs from those mirrors and verifies the minisign
# signature and the checksum recorded in mise.lock.
#
# Usage: bash scripts/check-lock-urls.sh [mise.lock]
set -euo pipefail

lock="${1:-mise.lock}"
mirror_list_url="https://ziglang.org/download/community-mirrors.txt"

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

mirrors=""
mirrors_loaded=0
zig_mirrors() {
  if ((mirrors_loaded == 0)); then
    mirrors="$(curl -sS -L --retry 2 --max-time 60 "$mirror_list_url" 2> /dev/null | tr -d '\r' | grep -E '^https?://' || true)"
    mirrors_loaded=1
  fi
  printf '%s\n' "$mirrors"
}

ok=0
warned=0
failed=0
report=""

while IFS= read -r url; do
  [[ -n "$url" ]] || continue
  code="$(status_of "$url")"
  if [[ "$code" == 2* ]]; then
    ok=$((ok + 1))
    continue
  fi
  file="${url##*/}"
  serving=""
  if [[ "$url" == https://ziglang.org/* ]]; then
    while IFS= read -r mirror; do
      [[ -n "$mirror" ]] || continue
      # The community mirrors ask automated clients to name themselves.
      if [[ "$(status_of "$mirror/$file?source=capnpc-wasm")" == 2* ]] &&
        [[ "$(status_of "$mirror/$file.minisig?source=capnpc-wasm")" == 2* ]]; then
        serving="$serving $mirror"
      fi
    done <<< "$(zig_mirrors)"
  fi
  if [[ -n "$serving" ]]; then
    warned=$((warned + 1))
    message="$url returned HTTP $code; still served with its .minisig by:$serving"
    echo "WARN $message"
    annotate warning "$message"
    report="$report"$'\n'"- WARN $message"
  else
    failed=$((failed + 1))
    message="$url returned HTTP $code and no other source serves $file"
    echo "FAIL $message"
    annotate error "$message"
    report="$report"$'\n'"- FAIL $message"
  fi
done <<< "$(sed -n 's/^url = "\([^"]*\)"$/\1/p' "$lock" | sort -u)"

summary="$ok locked URLs served, $warned served only by mirrors, $failed unavailable ($lock)"
echo "$summary"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '### Locked download URLs\n\n%s\n%s\n' "$summary" "$report" >> "$GITHUB_STEP_SUMMARY"
fi
((failed == 0))
