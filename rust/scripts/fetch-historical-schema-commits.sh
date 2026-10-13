#!/usr/bin/env bash
# Actions checkouts default to depth 1, so git archive of these commits fails
# with "not a tree object". Fetch the exact objects the storage migration
# tests archive. A missing object remains a hard failure.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"

commits=(
  87b30cd13cfa496829edbef6e6d1c25be29e92d1
  ac0153b682d9565b8b2255b2b2747bee7f9b82d2
  71e25e7731feddd0eaec05a0d1070dc13de790a7
)

for commit in "${commits[@]}"; do
  if git cat-file -e "${commit}^{tree}" 2>/dev/null; then
    continue
  fi
  git fetch --no-tags --depth=1 origin "$commit"
  git cat-file -e "${commit}^{tree}"
done

git archive --format=tar 71e25e7731feddd0eaec05a0d1070dc13de790a7 \
  web/apps/server/src/db \
  web/apps/server/src/services \
  >/dev/null
