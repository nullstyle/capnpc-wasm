#!/usr/bin/env bash
# shellcheck shell=bash
#
# Mutual exclusion for build outputs. Sourced; the caller sets
# `set -euo pipefail`. mise runs the build tasks in parallel by design, so
# each script locks only its own outputs, and two invocations of the same
# script (two terminals, a test alongside a release) take turns.
#
# acquire_build_lock <lock dir> [--no-trap]
#   Creates <lock dir> atomically and records this process id in it. While
#   another live process of this user holds it, waits (one note on stderr).
#   A lock whose recorded process is gone, or that has had no process id for
#   over a minute, is stale and is removed. Unless --no-trap is given, the
#   lock is released on EXIT; a caller with its own EXIT trap passes --no-trap
#   and calls release_build_lock from that trap.
# release_build_lock
#   Removes the lock this process holds, if any.

build_lock_dir=""

acquire_build_lock() {
  local dir="$1" owner waited=0
  mkdir -p "$(dirname "$dir")"
  while ! mkdir "$dir" 2> /dev/null; do
    owner="$(cat "$dir/pid" 2> /dev/null || true)"
    if [[ -n "$owner" ]]; then
      if ! kill -0 "$owner" 2> /dev/null; then
        echo "removing stale lock $dir (process $owner is gone)" >&2
        rm -rf "$dir"
        continue
      fi
    elif [[ -n "$(find "$dir" -maxdepth 0 -mmin +1 2> /dev/null)" ]]; then
      echo "removing stale lock $dir (no owner recorded for over a minute)" >&2
      rm -rf "$dir"
      continue
    fi
    if ((waited == 0)); then
      echo "waiting for $dir held by process ${owner:-unknown}" >&2
    fi
    waited=$((waited + 1))
    if ((waited > 1800)); then
      echo "gave up waiting for $dir after 30 minutes" >&2
      return 1
    fi
    sleep 1
  done
  echo "$$" > "$dir/pid"
  build_lock_dir="$dir"
  if [[ "${2:-}" != --no-trap ]]; then
    trap release_build_lock EXIT
  fi
}

release_build_lock() {
  if [[ -n "$build_lock_dir" ]]; then
    rm -rf "$build_lock_dir"
    build_lock_dir=""
  fi
}
