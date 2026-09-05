#!/usr/bin/env bash
# Full workflow API smoke test for Print Partner web (self-host).
# Usage: BASE=http://localhost:8080 ./web/scripts/workflow-smoke.sh
# Local archive: SOURCE_KIND=local SOURCE_UPLOAD_ZIP=source.zip BASE=... ./web/scripts/workflow-smoke.sh
set -euo pipefail

BASE="${BASE:-http://localhost:8080}"
SOURCE_URL="${SOURCE_URL:-https://github.com/Klipper3d/klipper}"
SOURCE_BRANCH="${SOURCE_BRANCH:-master}"
SOURCE_KIND="${SOURCE_KIND:-github}"
SOURCE_UPLOAD_FILE="${SOURCE_UPLOAD_FILE:-}"
SOURCE_UPLOAD_ZIP="${SOURCE_UPLOAD_ZIP:-}"
PLAN_NAME="${PLAN_NAME:-smoke-test-plan-$(date +%s)}"
SOURCE_NAME="${SOURCE_NAME:-Smoke Source ${PLAN_NAME}}"

if [[ -n "$SOURCE_UPLOAD_FILE" && -n "$SOURCE_UPLOAD_ZIP" ]]; then
  echo "Set only one of SOURCE_UPLOAD_FILE or SOURCE_UPLOAD_ZIP." >&2
  exit 2
fi
if [[ "$SOURCE_KIND" == "local" && -z "$SOURCE_UPLOAD_FILE" && -z "$SOURCE_UPLOAD_ZIP" ]]; then
  echo "SOURCE_KIND=local requires SOURCE_UPLOAD_FILE or SOURCE_UPLOAD_ZIP so the smoke test can create an immutable Source revision." >&2
  exit 2
fi
if [[ "$SOURCE_KIND" != "local" && ( -n "$SOURCE_UPLOAD_FILE" || -n "$SOURCE_UPLOAD_ZIP" ) ]]; then
  echo "SOURCE_UPLOAD_FILE and SOURCE_UPLOAD_ZIP require SOURCE_KIND=local." >&2
  exit 2
fi
if [[ -n "$SOURCE_UPLOAD_FILE" && ! -r "$SOURCE_UPLOAD_FILE" ]]; then
  echo "SOURCE_UPLOAD_FILE is not readable: $SOURCE_UPLOAD_FILE" >&2
  exit 2
fi
if [[ -n "$SOURCE_UPLOAD_ZIP" && ! -r "$SOURCE_UPLOAD_ZIP" ]]; then
  echo "SOURCE_UPLOAD_ZIP is not readable: $SOURCE_UPLOAD_ZIP" >&2
  exit 2
fi

AUTH_ARGS=()
if [[ -n "${PRINT_PARTNER_API_KEY:-}" ]]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${PRINT_PARTNER_API_KEY}")
fi

request() { curl --fail-with-body --show-error "${AUTH_ARGS[@]}" "$@"; }
body_only() { sed '$d'; }
http_code() { tail -1 | sed 's/HTTP://'; }

wait_job() {
  local job_id=$1
  local attempt status
  for ((attempt = 1; attempt <= 90; attempt++)); do
    status=$(request -s "$BASE/jobs/$job_id" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))")
    echo "    job $job_id: $status"
    case "$status" in
      done)
        request -s "$BASE/jobs/$job_id" | python3 -m json.tool | sed -n '1,20p'
        return 0
        ;;
      error|cancelled)
        request -s "$BASE/jobs/$job_id" | python3 -m json.tool | sed -n '1,20p'
        return 1
        ;;
    esac
    sleep 2
  done
  echo "    job timed out"
  return 1
}

echo "== 0. GET /health =="
request -s -w "\nHTTP:%{http_code}\n" "$BASE/health" | tee /tmp/pp-smoke-health.txt
grep -q '"ok":true' /tmp/pp-smoke-health.txt

echo "== 1. POST /sources =="
if [[ "$SOURCE_KIND" == "local" ]]; then
  SOURCE_PAYLOAD=$(python3 -c 'import json,sys; print(json.dumps({"name":sys.argv[1],"source_kind":"local"}))' "$SOURCE_NAME")
else
  SOURCE_PAYLOAD=$(python3 -c 'import json,sys; print(json.dumps({"name":sys.argv[1],"url":sys.argv[2],"branch":sys.argv[3],"source_kind":sys.argv[4]}))' "$SOURCE_NAME" "$SOURCE_URL" "$SOURCE_BRANCH" "$SOURCE_KIND")
fi
SRC_RESP=$(request -s -w "\nHTTP:%{http_code}" -X POST "$BASE/sources" \
  -H 'Content-Type: application/json' \
  -d "$SOURCE_PAYLOAD")
echo "$SRC_RESP" | body_only
echo "HTTP:$(echo "$SRC_RESP" | http_code)"
SOURCE_ID=$(echo "$SRC_RESP" | body_only | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

if [[ -n "$SOURCE_UPLOAD_FILE" ]]; then
  echo "== 1b. POST /sources/$SOURCE_ID/upload-files =="
  request --silent -X POST "$BASE/sources/$SOURCE_ID/upload-files" \
    -F "files=@${SOURCE_UPLOAD_FILE}" \
    -F 'relative_paths=["cube.stl"]' \
    | python3 -m json.tool
fi

if [[ -n "$SOURCE_UPLOAD_ZIP" ]]; then
  echo "== 1b. POST /sources/$SOURCE_ID/upload-zip =="
  request --silent -X POST "$BASE/sources/$SOURCE_ID/upload-zip" \
    -F "file=@${SOURCE_UPLOAD_ZIP}" \
    | python3 -m json.tool
fi

if [[ "$SOURCE_KIND" == "local" ]]; then
  echo "== 2. Local upload published an immutable revision; sync not required =="
else
  echo "== 2. POST /jobs/sync =="
  SYNC_RESP=$(request -s -w "\nHTTP:%{http_code}" -X POST "$BASE/jobs/sync" \
    -H 'Content-Type: application/json' \
    -d "{\"project_id\": $SOURCE_ID}")
  echo "$SYNC_RESP" | body_only
  echo "HTTP:$(echo "$SYNC_RESP" | http_code)"
  SYNC_JOB=$(echo "$SYNC_RESP" | body_only | python3 -c "import sys,json; print(json.load(sys.stdin)['job_id'])")
  wait_job "$SYNC_JOB"
fi

echo "== 3. POST /plans =="
PLAN_PAYLOAD=$(python3 -c 'import json,sys; print(json.dumps({"name":sys.argv[1]}))' "$PLAN_NAME")
PLAN_RESP=$(request -s -w "\nHTTP:%{http_code}" -X POST "$BASE/plans" \
  -H 'Content-Type: application/json' \
  -d "$PLAN_PAYLOAD")
echo "$PLAN_RESP" | body_only
echo "HTTP:$(echo "$PLAN_RESP" | http_code)"
PLAN_ID=$(echo "$PLAN_RESP" | body_only | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

echo "== 4. PUT /plans/$PLAN_ID/layers/base =="
LAYER_RESP=$(request -s -w "\nHTTP:%{http_code}" -X PUT "$BASE/plans/$PLAN_ID/layers/base" \
  -H 'Content-Type: application/json' \
  -d "{\"project_id\": $SOURCE_ID}")
echo "$LAYER_RESP" | body_only
echo "HTTP:$(echo "$LAYER_RESP" | http_code)"

echo "== 5. POST /plans/$PLAN_ID/drafts/recompute =="
DRAFT_RESP=$(request -s -w "\nHTTP:%{http_code}" -X POST "$BASE/plans/$PLAN_ID/drafts/recompute" \
  -H "Idempotency-Key: smoke-recompute-$PLAN_ID" \
  -H 'Content-Type: application/json' \
  -d '{"apply_manifest":true}')
echo "$DRAFT_RESP" | body_only
echo "HTTP:$(echo "$DRAFT_RESP" | http_code)"
DRAFT_ID=$(echo "$DRAFT_RESP" | body_only | python3 -c "import sys,json; print(json.load(sys.stdin)['draft']['draft_id'])")
DRAFT_DIGEST=$(echo "$DRAFT_RESP" | body_only | python3 -c "import sys,json; print(json.load(sys.stdin)['draft']['snapshot_digest'])")
DRAFT_LIFECYCLE=$(echo "$DRAFT_RESP" | body_only | python3 -c "import sys,json; print(json.load(sys.stdin)['draft']['lifecycle_version'])")
DRAFT_BASE=$(echo "$DRAFT_RESP" | body_only | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin)['draft']['base'],separators=(',',':')))")

echo "== 5b. POST /plans/$PLAN_ID/drafts/$DRAFT_ID/apply =="
APPLY_RESP=$(request -s -w "\nHTTP:%{http_code}" -X POST "$BASE/plans/$PLAN_ID/drafts/$DRAFT_ID/apply" \
  -H "Idempotency-Key: smoke-apply-$PLAN_ID-$DRAFT_ID" \
  -H 'Content-Type: application/json' \
  -d "{\"expected_snapshot_digest\":\"$DRAFT_DIGEST\",\"expected_lifecycle_version\":$DRAFT_LIFECYCLE,\"expected_base\":$DRAFT_BASE}")
echo "$APPLY_RESP" | body_only
echo "HTTP:$(echo "$APPLY_RESP" | http_code)"
echo "$APPLY_RESP" | body_only | python3 -c "import sys,json; print('accepted revision', json.load(sys.stdin)['revision_id'])"

echo "== 6. GET /plans/$PLAN_ID/parts =="
PARTS_RESP=$(request -s -w "\nHTTP:%{http_code}" "$BASE/plans/$PLAN_ID/parts?limit=3")
echo "$PARTS_RESP" | body_only | python3 -m json.tool
echo "HTTP:$(echo "$PARTS_RESP" | http_code)"
PART_ID=$(
  echo "$PARTS_RESP" | body_only | python3 -c \
    "import sys,json; parts=json.load(sys.stdin)['parts']; not parts and sys.exit('workflow produced zero parts'); print(parts[0]['id'])"
)

echo "== 7. GET /plans/$PLAN_ID/checkoff =="
CHECK_RESP=$(request -s -w "\nHTTP:%{http_code}" "$BASE/plans/$PLAN_ID/checkoff")
echo "$CHECK_RESP" | body_only | python3 -m json.tool | sed -n '1,25p'
echo "HTTP:$(echo "$CHECK_RESP" | http_code)"

echo "== 8. PATCH /parts/{id}/progress =="
PROG_RESP=$(request -s -w "\nHTTP:%{http_code}" -X PATCH "$BASE/parts/$PART_ID/progress" \
  -H 'Content-Type: application/json' \
  -d '{"unit_index":0,"completed":true}')
echo "$PROG_RESP" | body_only
echo "HTTP:$(echo "$PROG_RESP" | http_code)"

echo "== 9. POST /jobs/export-stl-pack =="
EXP_RESP=$(request -s -w "\nHTTP:%{http_code}" -X POST "$BASE/jobs/export-stl-pack" \
  -H 'Content-Type: application/json' \
  -d "{\"profile_id\": $PLAN_ID}")
echo "$EXP_RESP" | body_only
echo "HTTP:$(echo "$EXP_RESP" | http_code)"
EXP_JOB=$(echo "$EXP_RESP" | body_only | python3 -c "import sys,json; print(json.load(sys.stdin)['job_id'])")
wait_job "$EXP_JOB"
request -s "$BASE/jobs/$EXP_JOB" | python3 -c \
  "import sys,json; result=json.load(sys.stdin).get('result') or {}; result.get('file_total', 0) < 1 and sys.exit('workflow exported zero files')"

echo "== 10. Static assets =="
request -s -o /dev/null -w "GET / HTTP:%{http_code}\n" "$BASE/"
ASSETS=$(request -s "$BASE/" | grep -oE 'assets/[^"]+' | sed -n '1,3p')
if [[ -z "$ASSETS" ]]; then
  echo "production page did not reference any static assets" >&2
  exit 1
fi
while IFS= read -r p; do
  request -s -o /dev/null -w "GET /$p HTTP:%{http_code}\n" "$BASE/$p"
done <<< "$ASSETS"

echo "Smoke workflow complete."
