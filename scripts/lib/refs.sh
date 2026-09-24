#!/usr/bin/env bash
# shellcheck shell=bash
#
# Reference revision helpers for the build scripts and doctor. Sourced; the
# caller sets `set -euo pipefail`.
#
# ref_revision <name>
#   Prints the commit this repository records for ref/<name>: the gitlink in
#   the index, which `git submodule update` checks out and which a reference
#   bump stages (`git add ref/<name>`) before it is committed. Builds export
#   and compile that commit, never whatever a checkout happens to contain.
# ref_checkout_problem <name>
#   Prints one line describing why ref/<name> cannot be used, or nothing when
#   the checkout is initialized, at the recorded commit, and has no local
#   changes or untracked files.
# require_pristine_ref <name>...
#   Fails with that description for the first reference that has a problem.

ref_revision() {
  git rev-parse ":ref/$1"
}

ref_checkout_problem() {
  local name="$1" dir expected actual changes
  dir="ref/$name"
  if ! expected="$(git rev-parse --verify --quiet ":$dir")"; then
    echo "$dir is not a reference recorded by this repository"
    return 0
  fi
  if [[ ! -e "$dir/.git" ]]; then
    echo "$dir is not initialized; run mise run refs:sync"
    return 0
  fi
  if ! actual="$(git -C "$dir" rev-parse --verify --quiet HEAD)"; then
    echo "$dir has no checked-out commit; run mise run refs:sync"
    return 0
  fi
  if [[ "$actual" != "$expected" ]]; then
    echo "$dir is at $actual but this repository records $expected; run mise run refs:sync"
    return 0
  fi
  changes="$(git -C "$dir" status --porcelain)"
  if [[ -n "$changes" ]]; then
    echo "$dir has local changes or untracked files; restore it (see git -C $dir status)"
    return 0
  fi
}

require_pristine_ref() {
  local name problem
  for name in "$@"; do
    problem="$(ref_checkout_problem "$name")"
    if [[ -n "$problem" ]]; then
      echo "error: $problem" >&2
      return 1
    fi
  done
}
