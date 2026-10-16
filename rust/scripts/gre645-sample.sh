#!/usr/bin/env bash
# GRE-645 diagnostic only. Samples busy processes every 2s, or summarizes a sample file.
out="$RUNNER_TEMP/ps-$1.txt"
if [[ "$1" == summary ]]; then
  out="$RUNNER_TEMP/ps-$2.txt"
  echo "samples: $(grep -c '^T ' "$out")"
  echo "busiest commands (count of samples >= 50% CPU):"
  awk '$1 != "T" && $5+0 >= 50 {print $7}' "$out" | sed 's/-[0-9a-f]\{16\}$//' | sort | uniq -c | sort -rn | head -15
  echo "load samples:"; grep '^T ' "$out" | awk 'NR % 10 == 1'
  exit 0
fi
while :; do
  echo "T $(date +%T) $(sysctl -n vm.loadavg)"
  ps -Ao pid,ppid,pgid,stat,%cpu,time,comm -r | sed 1d | head -12
  sleep 2
done > "$out"
