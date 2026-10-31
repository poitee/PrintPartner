---
name: pp-mission-qa
description: Start, drive, and stop Print Partner during Mission user testing. Use for local or Factory Environment QA of a migration slice.
---

# Mission user testing

Read [AGENTS.md](../../../AGENTS.md) and the slice's acceptance criteria. This
skill uses existing launchers, not a second QA platform. Static checks and unit
tests belong to `pp-readiness`; UI evidence follows `pp-verify`.

## Choose the runtime

- `web/apps/server` owns Node compatibility behavior.
- `rust/crates/pp-server` owns only the operations already migrated to Rust.
- `web/apps/web` is shared. Pick the server that owns the operation under test.
- `rust/crates/pp-desktop` needs actual native execution for window, tray,
  protocol, and OS behavior. Browser evidence is not native acceptance.
- `slicer-sidecar` uses a synthetic slicer in tests. Never send a real print.

State the exact HEAD, operation owner, fixture, expected result, feature modes,
time budget, and cleanup before launching. Use fresh data and loopback ports.
Keep `desktop_rebuild` off unless the slice explicitly tests its on mode.

## Node server and shared React UI

Use the launch block in [pp-verify](../pp-verify/SKILL.md#web-ui), with fresh
`PP_VERIFY_STATE_DIR`, `PP_VERIFY_EVIDENCE_DIR`, data directory, and two free
loopback ports. The start command is:

```sh
node scripts/verify-print-partner/control-print-partner.mjs launch \
  --mode npm --data-dir "$ROOT/data" --api-port "$API_PORT" --ui-port "$UI_PORT"
node scripts/verify-print-partner/control-print-partner.mjs doctor
```

Keep those environment variables unchanged through cleanup. The launcher waits
for readiness. Its JSON state is `$PP_VERIFY_STATE_DIR/state.json`; the service
log is `$PP_VERIFY_STATE_DIR/<project>/npm-dev.log`, where `project` comes from
that state. Inspect only relevant, non-secret log lines.

Invoke `agent-browser` before driving the UI. Use a worktree-scoped browser
session, keep the same session through interactions and capture, and assert
the expected visible state. Do not reload to capture an open dialog.
Close that browser session, then run:

```sh
node scripts/verify-print-partner/control-print-partner.mjs cleanup
```

Register cleanup before launch so failures also stop owned services. Keep
evidence outside disposable data; remove only directories created by this run.

## Rust gateway

Follow [pp-verify's authenticated gateway flow](../pp-verify/SKILL.md#rust-gateway).
Create a private temporary directory outside the checkout. Launch in a managed
long-running process and redirect stdout/stderr to a private file:

```sh
python3 scripts/verify-rust-gateway/verify.py launch \
  --credential-file "$PRIVATE_DIR/credential.json" >"$PRIVATE_DIR/gateway.log" 2>&1
```

The credential path must not exist. Wait for `PP_SERVER_URL` in the log, not
merely for a successful build. Use one Playwright context to read `bootstrap_url`
from the credential file and establish the session. Never print that URL or
pass it to a browser CLI, shell argument, trace, or evidence upload. Capture
only after the redirect removes the bootstrap URL.

Assert the slice's result through that authenticated context. A bare `401`
does not prove that the operation works. When done, close the browser, send
SIGTERM to the owned launcher, and wait for its cleanup. Delete the credential
file and private directory after retaining only scrubbed evidence.

## Report

Record executed journeys and assertions, runtime owner, flag mode, exact HEAD,
duration, log location, screenshots, and cleanup outcome. For persistence
changes, include restart/recovery and stable IDs. For ownership changes,
include refusal by the non-owner and prove there was no second mutation.
Report missing browser/native/display tools as BLOCKED, never as a pass.
Follow the existing PR evidence rules; do not upload files without checking
them for credentials, customer data, and unrelated windows.
