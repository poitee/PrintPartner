#!/usr/bin/env bash
# Exercise the actual smoke helper with a stub pgrep under errexit.
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
eval "$(sed -n '/^check_no_leftovers() {/,/^}/p' "$script_dir/workflow-smoke.sh")"
fail() { printf '[smoke] FAIL: %s\n' "$*" >&2; exit 1; }
pgrep() {
  if test "$stub_status" = 0; then printf '4242\n'; fi
  return "$stub_status"
}

for probe in -g -P; do
  for stub_status in 0 1 2 3 7; do
    # Run as a standalone command with -e active, not inside an if condition.
    set +e
    output="$(set -e; check_no_leftovers "$probe" 123; printf 'no leftovers\n')"
    result=$?
    set -e
    if test "$stub_status" = 1; then
      test "$result" = 0
      test "$output" = 'no leftovers'
      printf 'pgrep %s exit %s -> PASS (no match)\n' "$probe" "$stub_status"
    else
      test "$result" = 1
      test -z "$output"
      printf 'pgrep %s exit %s -> FAIL (expected)\n' "$probe" "$stub_status"
    fi
  done
done
printf 'PASS: all pgrep status cases handled under set -e\n'
