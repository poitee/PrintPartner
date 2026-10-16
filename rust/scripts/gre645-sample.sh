#!/usr/bin/env bash
# GRE-645 diagnostic only. Every 5s, stack-samples up to two runtime_m0 processes above 50% CPU.
out="$RUNNER_TEMP/gre645-stacks"
mkdir -p "$out"
while :; do
  ps -Ao pid=,ppid=,%cpu=,args= -r | awk '$3+0 >= 50 && $4 ~ /runtime_m0/' | head -2 |
    while read -r pid ppid cpu args; do
      echo "== $(date +%T) load=$(sysctl -n vm.loadavg) pid=$pid ppid=$ppid cpu=$cpu parent=$(ps -o args= -p "$ppid" | cut -c1-120) args=$(echo "$args" | cut -c1-200)"
      sample "$pid" 1 -mayDie -file "$out/$pid.txt" >/dev/null 2>&1
      sed -n '/Sort by top of stack/,/^$/p' "$out/$pid.txt" | head -12
      grep -E '^ +[0-9]+ Thread_' "$out/$pid.txt" | head -8
    done
  sleep 5
done
