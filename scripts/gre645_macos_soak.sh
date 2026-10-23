#!/usr/bin/env bash
# Dispatch consecutive Rust cross-OS runs and require green unskipped rust (macos).
# Refs GRE-645. Chad-gated: refuses to burn macos-26 runners without --execute.
set -euo pipefail

WORKFLOW="${GRE645_WORKFLOW:-rust-cross-os.yml}"
JOB_NAME="${GRE645_JOB_NAME:-rust (macos)}"
POLL_SECONDS="${GRE645_POLL_SECONDS:-30}"
GH_BIN="${GRE645_GH:-gh}"

usage() {
  cat <<'EOF'
Usage: scripts/gre645_macos_soak.sh [options] [REF] [N] [OUT]

Dispatch N consecutive workflow_dispatch runs of Rust cross-OS on REF, wait for
each rust (macos) job (NEXTEST_FILTER all()), and append one JSONL evidence line
per green job. Stops on the first non-success (streak broken).

Defaults: REF=main N=20 OUT=/tmp/gre645-macos-soak.jsonl

Options:
  --dry-run     Plan only; never call workflow run (default)
  --execute     Actually dispatch (Chad-gated; burns hosted macos-26)
  -h, --help    Show this help

Environment:
  GRE645_GH            gh binary (default: gh; tests inject a stub)
  GRE645_WORKFLOW      workflow file (default: rust-cross-os.yml)
  GRE645_JOB_NAME      job name (default: rust (macos))
  GRE645_POLL_SECONDS  poll interval while waiting (default: 30)
EOF
}

mode=dry-run
ref=main
n=20
out=/tmp/gre645-macos-soak.jsonl
positional=()

while (($# > 0)); do
  case "$1" in
    --dry-run) mode=dry-run; shift ;;
    --execute) mode=execute; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; positional+=("$@"); break ;;
    -*)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *) positional+=("$1"); shift ;;
  esac
done

if ((${#positional[@]} > 0)); then ref="${positional[0]}"; fi
if ((${#positional[@]} > 1)); then n="${positional[1]}"; fi
if ((${#positional[@]} > 2)); then out="${positional[2]}"; fi

if ! [[ "$n" =~ ^[1-9][0-9]*$ ]]; then
  echo "N must be a positive integer, got: $n" >&2
  exit 2
fi

gh() {
  command "$GH_BIN" "$@"
}

require_tools() {
  command -v "$GH_BIN" >/dev/null
  command -v jq >/dev/null
  command -v python3 >/dev/null
}

list_dispatch_ids() {
  gh run list \
    --workflow "$WORKFLOW" \
    --branch "$ref" \
    --event workflow_dispatch \
    --limit 50 \
    --json databaseId \
    | jq -r '.[].databaseId'
}

dispatch_run() {
  local known run_id attempt
  known="$(list_dispatch_ids | sort -u)"
  gh workflow run "$WORKFLOW" --ref "$ref" >/dev/null
  for ((attempt = 1; attempt <= 60; attempt++)); do
    while read -r run_id; do
      [[ -z "$run_id" ]] && continue
      if [[ -z "$known" ]] || ! grep -qx "$run_id" <<<"$known"; then
        printf '%s\n' "$run_id"
        return 0
      fi
    done < <(list_dispatch_ids)
    sleep 2
  done
  echo "timed out waiting for new workflow_dispatch run of $WORKFLOW on $ref" >&2
  return 1
}

wait_macos_job() {
  local run_id="$1"
  local payload status conclusion
  while true; do
    payload="$(
      gh run view "$run_id" --json url,headSha,jobs \
        | jq --arg name "$JOB_NAME" '
            (.jobs[] | select(.name == $name)) as $job
            | {
                run_url: .url,
                sha: .headSha,
                job_url: $job.url,
                status: $job.status,
                conclusion: ($job.conclusion // "")
              }
          '
    )"
    if [[ -z "$payload" ]]; then
      echo "run $run_id has no job named '$JOB_NAME' yet" >&2
      sleep "$POLL_SECONDS"
      continue
    fi
    status="$(jq -r '.status' <<<"$payload")"
    conclusion="$(jq -r '.conclusion' <<<"$payload")"
    if [[ "$status" == "completed" ]]; then
      printf '%s\n' "$payload"
      if [[ "$conclusion" != "success" ]]; then
        return 1
      fi
      return 0
    fi
    sleep "$POLL_SECONDS"
  done
}

append_evidence() {
  local i="$1" payload="$2"
  python3 -c '
import json, sys
i = int(sys.argv[1])
payload = json.loads(sys.argv[2])
print(json.dumps({
    "i": i,
    "run": payload["run_url"],
    "job": payload["job_url"],
    "sha": payload["sha"],
    "conclusion": payload["conclusion"],
}, sort_keys=True))
' "$i" "$payload" >>"$out"
}

plan() {
  cat <<EOF
GRE-645 macOS soak plan (mode=$mode)
  workflow: $WORKFLOW
  job:      $JOB_NAME
  ref:      $ref
  count:    $n consecutive green unskipped hosted rust (macos)
  evidence: $out
EOF
  if [[ "$mode" == "dry-run" ]]; then
    cat <<'EOF'

Dry-run only: no workflow_dispatch. Chad must OK --execute before burning
hosted macos-26 (~N × up to 90m). Do not start while main rust (macos) is red.
EOF
  fi
}

main() {
  require_tools
  plan
  if [[ "$mode" != "execute" ]]; then
    exit 0
  fi
  : >"$out"
  local i run_id payload
  for ((i = 1; i <= n; i++)); do
    echo "soak $i/$n: dispatch $WORKFLOW --ref $ref" >&2
    run_id="$(dispatch_run)"
    echo "soak $i/$n: waiting for run $run_id job '$JOB_NAME'" >&2
    if ! payload="$(wait_macos_job "$run_id")"; then
      if [[ -n "${payload:-}" ]]; then
        echo "streak broken at $i/$n: $(jq -r '.conclusion' <<<"$payload") $(jq -r '.job_url' <<<"$payload")" >&2
      else
        echo "streak broken at $i/$n: run $run_id job '$JOB_NAME' failed" >&2
      fi
      exit 1
    fi
    append_evidence "$i" "$payload"
    echo "soak $i/$n: success $(jq -r '.job_url' <<<"$payload")" >&2
  done
  echo "GRE-645 soak complete: $n consecutive green $JOB_NAME jobs -> $out" >&2
}

main
