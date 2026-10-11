#!/usr/bin/env bash
# Stage-1 pp-server smoke: boot on loopback, authenticate, exercise HTTP, WS and
# MCP through the gateway, prove the data lock is held while running and
# released after a clean stop. Portable to macOS bash 3.2 and Linux.
set -euo pipefail

usage='Usage: bash rust/scripts/workflow-smoke.sh SERVER_BINARY NODE_BINARY'
server="${1:?$usage}"
node="${2:?$usage}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
commit="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["commit"])' "$root/rust/bundle-manifest.json")"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/pp-workflow-smoke.XXXXXX")"
data="$fixture/data"
credentials="$fixture/credentials.json"
server_pid=''
ws_pid=''

log() { printf '[smoke] %s\n' "$*"; }
fail() { printf '[smoke] FAIL: %s\n' "$*" >&2; exit 1; }
alive() { kill -0 "$1" 2>/dev/null; }

cleanup() {
  result=$?
  trap - EXIT
  if test -n "$ws_pid" && alive "$ws_pid"; then kill "$ws_pid" 2>/dev/null || true; fi
  if test -n "$server_pid" && alive "$server_pid"; then
    kill -TERM "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
    result=1
  fi
  rm -f "$credentials"
  if ((result != 0)); then
    log "server stderr:"
    cat "$fixture/server.err" >&2 2>/dev/null || true
    cat "$fixture/ws.err" >&2 2>/dev/null || true
  fi
  log "fixture retained at $fixture"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Exit status 0 when the OS lock on the data directory is free, 1 when held.
lock_free() {
  python3 - "$data/.desktop.lock" <<'PY'
import fcntl, sys
with open(sys.argv[1], 'rb') as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit(1)
    fcntl.flock(lock, fcntl.LOCK_UN)
PY
}

log "boot: $server (commit $commit)"
"$server" --data "$data" --web "$root/web" --node "$node" --commit "$commit" \
  --test-credential-file "$credentials" >"$fixture/server.out" 2>"$fixture/server.err" &
server_pid=$!
SECONDS=0
until test -s "$fixture/server.out"; do
  alive "$server_pid" || fail 'server exited before readiness'
  ((SECONDS < 60)) || fail 'server readiness timed out'
  sleep 0.2
done
origin="$(head -n 1 "$fixture/server.out")"
case "$origin" in
  http://127.0.0.1:*) ;;
  *) fail "server did not print a loopback origin: $origin" ;;
esac
log "ready: $origin (pid $server_pid)"

# Data lock taken at boot.
test -f "$data/.desktop-owner.json" || fail 'owner marker missing after boot'
if lock_free; then fail 'data lock is not held while running'; fi
log 'lock: held at boot (flock EWOULDBLOCK, owner marker present)'

# Authenticate with the one-use bootstrap credential.
test "$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777))' "$credentials")" = 0o600 \
  || fail 'credential file is not 0600'
bootstrap="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["bootstrap_url"])' "$credentials")"
rm -f "$credentials"
status="$(curl --silent --max-time 10 --output /dev/null --write-out '%{http_code}' "$origin/__runtime")"
test "$status" = 401 || fail "unauthenticated request returned $status, expected 401"
cookie="$(curl --silent --show-error --max-time 10 --dump-header - --output /dev/null "$bootstrap" \
  | tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: \([^;]*\).*/\1/p' | head -n 1)"
test -n "$cookie" || fail 'bootstrap did not set a session cookie'
status="$(curl --silent --max-time 10 --output /dev/null --write-out '%{http_code}' "$bootstrap")"
test "$status" = 401 || fail "bootstrap reuse returned $status, expected 401"

# Authenticated HTTP: runtime state from Rust, then a round trip into Node.
runtime_json="$(curl --fail --silent --show-error --max-time 10 -H "Cookie: $cookie" "$origin/__runtime")"
child_pid="$(printf '%s' "$runtime_json" | python3 -c 'import json,sys; s=json.load(sys.stdin)["compat"]; assert s["state"]=="ready", s; print(s["pid"])')"
alive "$child_pid" || fail "compat child $child_pid is not running"
plan="$(curl --fail --silent --show-error --max-time 30 -H "Cookie: $cookie" -H "Origin: $origin" \
  -H 'Content-Type: application/json' -d '{"name":"Workflow smoke"}' "$origin/plans")"
plan_id="$(printf '%s' "$plan" | python3 -c 'import json,sys; p=json.load(sys.stdin); assert p["name"]=="Workflow smoke", p; print(p["id"])')"
curl --fail --silent --show-error --max-time 30 -H "Cookie: $cookie" -H "Origin: $origin" "$origin/plans" \
  | python3 -c 'import json,sys; assert any(p["id"]==int(sys.argv[1]) for p in json.load(sys.stdin)["profiles"])' "$plan_id" \
  || fail 'created plan not listed'
log "http: 401 without session, bootstrap single-use, /__runtime ready (child $child_pid), POST+GET /plans id=$plan_id"

# WebSocket: hold an admitted upgrade open until shutdown closes it.
printf '{"origin":"%s","cookie":"%s","mode":"hold"}' "$origin" "$cookie" \
  | "$node" "$root/rust/tests/gateway_ws.mjs" >"$fixture/ws.out" 2>"$fixture/ws.err" &
ws_pid=$!
SECONDS=0
until grep -q '"ready":true' "$fixture/ws.out" 2>/dev/null; do
  alive "$ws_pid" || fail 'websocket client exited before open'
  ((SECONDS < 15)) || fail 'websocket open timed out'
  sleep 0.1
done
log 'ws: /ws/profile-sync upgrade admitted and open'

# MCP: authenticated JSON-RPC reaches the gateway, which refuses it fail-closed
# until API-key authorization is verified (see rust/README.md).
mcp_body='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"pp-workflow-smoke","version":"1"}}}'
status="$(curl --silent --max-time 10 --output /dev/null --write-out '%{http_code}' \
  -H "Origin: $origin" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d "$mcp_body" "$origin/api/v1/mcp")"
test "$status" = 401 || fail "unauthenticated MCP returned $status, expected 401"
mcp="$(curl --silent --max-time 10 --write-out '\n%{http_code}' -H "Cookie: $cookie" -H "Origin: $origin" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d "$mcp_body" "$origin/api/v1/mcp")"
test "$(printf '%s' "$mcp" | tail -n 1)" = 403 || fail "authenticated MCP returned: $mcp"
printf '%s' "$mcp" | grep -q 'MCP is disabled in this foundation' || fail "unexpected MCP refusal: $mcp"
log 'mcp: initialize -> 401 without session, 403 fail-closed with session'

# Clean stop: SIGTERM, exit 0, WS closed, no child or process-group leftovers.
kill -TERM "$server_pid"
set +e
wait "$server_pid"
server_exit=$?
set -e
server_pid_stopped="$server_pid"
server_pid=''
test "$server_exit" = 0 || fail "server exited $server_exit after SIGTERM"
set +e
wait "$ws_pid"
ws_exit=$?
set -e
ws_pid=''
test "$ws_exit" = 0 || fail "websocket client exited $ws_exit"
grep -q '"closed":true' "$fixture/ws.out" || fail 'websocket was not closed by shutdown'
if alive "$child_pid"; then fail "compat child $child_pid survived stop"; fi
leftover="$(pgrep -g "$child_pid" 2>/dev/null || true)$(pgrep -P "$server_pid_stopped" 2>/dev/null || true)"
test -z "$leftover" || fail "leftover processes after stop: $leftover"
log "stop: SIGTERM -> exit 0, ws closed, child $child_pid gone, no process-group or child leftovers"

# Data lock released at stop.
test ! -e "$data/.desktop-owner.json" || fail 'owner marker survived stop'
lock_free || fail 'data lock still held after stop'
log 'lock: released at stop (flock acquired, owner marker removed)'

python3 - "$commit" "$origin" "$child_pid" "$plan_id" <<'PY'
import json, platform, sys
print(json.dumps({"proof_class": "headless_unsigned", "case": "stage1_server_smoke", "os": platform.system(),
                  "arch": platform.machine(), "commit": sys.argv[1], "origin": sys.argv[2], "child_pid": int(sys.argv[3]),
                  "plan_id": int(sys.argv[4]), "http_authenticated": True, "ws_open_and_closed_on_stop": True,
                  "mcp_fail_closed": True, "lock_held_at_boot": True, "lock_released_at_stop": True,
                  "server_exit": 0, "leftover_processes": 0}))
PY
log PASS
