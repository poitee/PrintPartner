#!/usr/bin/env bash
set -euo pipefail

image="${1:?Usage: bash scripts/docker-startup-smoke.sh IMAGE}"
token="$(node -p 'require("node:crypto").randomUUID()')"
volume="pp-startup-${token}"
container="pp-startup-${token}"
volume_created=false
container_created=false

cleanup() {
  result=$?
  trap - EXIT
  if "$container_created"; then
    if (( result != 0 )); then docker logs "$container" >&2 || true; fi
    docker rm --force "$container" >/dev/null || result=1
  fi
  if "$volume_created"; then docker volume rm "$volume" >/dev/null || result=1; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker volume create "$volume" >/dev/null
volume_created=true
# volume-nocopy prevents Docker from pre-populating the image's owned /data.
docker run --rm --user 0:0 --entrypoint sh \
  --mount "type=volume,source=${volume},target=/data,volume-nocopy" \
  "$image" -ec 'mkdir -p /data/private; printf preserved > /data/private/sentinel; chmod 700 /data /data/private; chmod 600 /data/private/sentinel; test "$(stat -c %u /data/private/sentinel)" = 0'
docker run --detach --name "$container" \
  --publish 127.0.0.1::8080 \
  --mount "type=volume,source=${volume},target=/data,volume-nocopy" \
  --env PRINT_PARTNER_API_KEY=startup-smoke-only \
  "$image" >/dev/null
container_created=true
address="http://$(docker port "$container" 8080/tcp)"

wait_for_health() {
  for ((attempt = 1; attempt <= 60; attempt++)); do
    if curl --fail --silent --max-time 2 "$address/health" >/dev/null; then return 0; fi
    if [[ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]]; then return 1; fi
    sleep 2
  done
  return 1
}

wait_for_health
docker exec --user 1000:1000 "$container" sh -ec '
  test "$(cat /data/private/sentinel)" = preserved
  test "$(stat -c %u:%g /data/private/sentinel)" = 1000:1000
  test "$(stat -c %u:%g /data/print-partner.db)" = 1000:1000
  test "$(awk "/^Uid:/{print \$2}" /proc/1/status)" = 1000
  found=false
  for process in /proc/[0-9]*; do
    if [ "$(cat "$process/comm" 2>/dev/null)" = node ]; then
      test "$(awk "/^Uid:/{print \$2}" "$process/status")" = 1000
      found=true
    fi
  done
  "$found"
'
curl --fail --silent --show-error --max-time 10 \
  -H 'Authorization: Bearer startup-smoke-only' -H 'Content-Type: application/json' \
  -d '{"name":"Startup persistence smoke"}' "$address/plans" \
  | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const p=JSON.parse(s);require("node:assert/strict").equal(p.name,"Startup persistence smoke");require("node:assert/strict").ok(Number.isInteger(p.id));})'
docker stop --time 30 "$container" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$container")" = 0
docker start "$container" >/dev/null
# Docker can assign a different ephemeral host port after a restart.
address="http://$(docker port "$container" 8080/tcp)"
wait_for_health
curl --fail --silent --show-error --max-time 10 \
  -H 'Authorization: Bearer startup-smoke-only' "$address/plans" \
  | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const p=JSON.parse(s);require("node:assert/strict").ok(p.profiles.some(x=>x.name==="Startup persistence smoke"));})'
docker exec --user 1000:1000 "$container" sh -ec 'test "$(cat /data/private/sentinel)" = preserved'
docker stop --time 30 "$container" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$container")" = 0
printf 'Fresh-volume ownership, non-root runtime, graceful shutdown, and restart persistence passed.\n'
