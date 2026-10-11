#!/usr/bin/env bash
# Fail if any non-local GitHub Actions `uses:` ref is not pinned to a 40-char SHA.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WF_DIR="${ROOT}/.github/workflows"

if [[ ! -d "$WF_DIR" ]]; then
  echo "error: missing ${WF_DIR}" >&2
  exit 1
fi

# Matches owner/repo[@path]@ref (and similar), capturing the ref after the final @.
# Local actions (./...) are exempt.
uses_re='^[[:space:]]*-?[[:space:]]*uses:[[:space:]]*([^[:space:]#]+)'

unpinned=0
checked=0
exempt=0

while IFS= read -r -d '' file; do
  line_no=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_no=$((line_no + 1))
    [[ "$line" =~ $uses_re ]] || continue
    ref="${BASH_REMATCH[1]}"

    if [[ "$ref" == ./* ]]; then
      exempt=$((exempt + 1))
      continue
    fi

    checked=$((checked + 1))
    action="${ref%@*}"
    pin="${ref##*@}"

    if [[ "$pin" =~ ^[0-9a-fA-F]{40}$ ]]; then
      continue
    fi

    printf 'unpinned: %s:%d: %s\n' "${file#"$ROOT"/}" "$line_no" "$ref"
    unpinned=$((unpinned + 1))
  done < "$file"
done < <(find "$WF_DIR" -type f \( -name '*.yml' -o -name '*.yaml' \) -print0 | sort -z)

echo "checked=${checked} exempt_local=${exempt} unpinned=${unpinned}"

if (( unpinned > 0 )); then
  echo "error: pin every non-local uses: to a 40-char commit SHA (with a # vX.Y.Z comment)." >&2
  exit 1
fi
