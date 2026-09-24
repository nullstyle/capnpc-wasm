#!/usr/bin/env bash
# shellcheck shell=bash
#
# Mutual exclusion for build outputs. Sourced; the caller sets
# `set -euo pipefail`. mise runs the build tasks in parallel by design, so
# each script locks only its own outputs, and two invocations of the same
# script (two terminals, a test alongside a release) take turns.
#
# The lock is a directory that always holds exactly one owner marker,
# owner.<pid>. It is created with its marker under a temporary name and
# renamed into place, so only atomic operations make it visible or change
# its owner. A waiter that finds the owner dead renames that very marker;
# the name carries the pid, so the rename fails harmlessly if a live process
# has re-owned the lock in the meantime. Only the owner removes the
# directory, on release. A takeover or reclaim that cannot be performed (a
# lock left by another user, an unwritable directory) makes the waiter wait
# like everyone else, with the same timeout, never spin.
#
# acquire_build_lock <lock dir> [--no-trap]
#   Waits while a live process owns the lock (one note on stderr), takes
#   over a lock whose owner is gone, and gives up after
#   CAPNP_WASM_LOCK_TIMEOUT seconds (default 1800). Unless --no-trap is
#   given, the lock is released on EXIT; a caller with its own EXIT trap
#   passes --no-trap and calls release_build_lock from that trap. Call it
#   from the script's main shell, not from a subshell. A SIGTERM or SIGINT
#   delivered to the script's shell alone runs that EXIT trap and releases
#   the lock while a foreground child (zig, cmake, cargo) may keep running.
# release_build_lock
#   Removes the lock this process owns, if any. Ignored in a subshell, so a
#   background job can never release its parent's lock (bash does not run a
#   parent's EXIT trap in subshells; the guard is defensive).

build_lock_dir=""

build_lock_owner() {
  # Prints the pid recorded in the lock's owner marker, or nothing.
  local marker
  for marker in "$1"/owner.*; do
    [[ -e "$marker" ]] || continue
    printf '%s\n' "${marker##*/owner.}"
    return 0
  done
}

build_lock_process_alive() {
  # kill -0 fails with EPERM for another user's live process; ps still
  # lists it, so only a process nobody can find counts as gone.
  kill -0 "$1" 2> /dev/null || ps -p "$1" > /dev/null 2>&1
}

acquire_build_lock() {
  local dir="$1" staging owner reason waited=0
  local timeout="${CAPNP_WASM_LOCK_TIMEOUT:-1800}"
  if [[ "${BASH_SUBSHELL:-0}" -ne 0 ]]; then
    echo "acquire_build_lock must run in the script's main shell" >&2
    return 1
  fi
  mkdir -p "$(dirname "$dir")"
  staging="$dir.new.$$"
  while :; do
    if [[ ! -d "$dir" ]]; then
      # Rename a complete lock into place. If the lock appeared meanwhile,
      # mv puts the staging directory inside it and the marker is not at
      # the top level; that stray is removed and the loop continues.
      rm -rf "$staging"
      mkdir "$staging"
      : > "$staging/owner.$$"
      if mv "$staging" "$dir" 2> /dev/null && [[ -f "$dir/owner.$$" ]]; then
        break
      fi
      rm -rf "$staging" "${dir:?}/${staging##*/}" 2> /dev/null || true
    fi
    owner="$(build_lock_owner "$dir")"
    reason="held by process ${owner:-unknown}"
    if [[ -n "$owner" ]] && ! build_lock_process_alive "$owner"; then
      # Rename exactly that owner's marker away, then own the directory.
      if mv "$dir/owner.$owner" "$dir/dead.$owner.$$" 2> /dev/null; then
        : > "$dir/owner.$$"
        rm -f "$dir/dead.$owner.$$"
        echo "took over $dir from process $owner, which is gone" >&2
        break
      fi
      # Another waiter renamed it first, or this user cannot write the
      # directory: wait below like everyone else.
      reason="its owner $owner is gone but its marker cannot be renamed (another waiter may have taken over, or $dir is not writable)"
    elif [[ -z "$owner" && -d "$dir" ]] &&
         [[ -n "$(find "$dir" -maxdepth 0 -mmin +1 2> /dev/null)" ]]; then
      # No marker for over a minute: a takeover died between renaming the
      # old marker and writing its own, or this is a lock of an older
      # layout. Rename the directory away before removing it, and put it
      # back if a live lock replaced it in the meantime.
      if mv "$dir" "$dir.dead.$$" 2> /dev/null; then
        if [[ -n "$(build_lock_owner "$dir.dead.$$")" ]]; then
          mv "$dir.dead.$$" "$dir" 2> /dev/null ||
            echo "warning: could not restore $dir; remove $dir.dead.$$ by hand" >&2
        else
          echo "removed ownerless lock $dir" >&2
          rm -rf "$dir.dead.$$"
        fi
        continue
      fi
      reason="it has no owner marker and cannot be renamed ($(dirname "$dir") may not be writable)"
    fi
    if ((waited == 0)); then
      echo "waiting for $dir: $reason" >&2
    fi
    waited=$((waited + 1))
    if ((waited > timeout)); then
      echo "gave up waiting for $dir after $timeout seconds" >&2
      return 1
    fi
    sleep 1
  done
  build_lock_dir="$dir"
  if [[ "${2:-}" != --no-trap ]]; then
    trap release_build_lock EXIT
  fi
}

release_build_lock() {
  if [[ "${BASH_SUBSHELL:-0}" -ne 0 ]]; then
    return 0
  fi
  if [[ -n "$build_lock_dir" && -f "$build_lock_dir/owner.$$" ]]; then
    rm -rf "$build_lock_dir"
  fi
  build_lock_dir=""
}
