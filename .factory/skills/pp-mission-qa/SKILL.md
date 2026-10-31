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

Use the launch, browser-session, and cleanup instructions in
[pp-verify](../pp-verify/SKILL.md#web-ui). Do not maintain a second launch recipe.

Keep those environment variables unchanged through cleanup. The launcher waits
for readiness. Its JSON state is `$PP_VERIFY_STATE_DIR/state.json`; the service
log is `$PP_VERIFY_STATE_DIR/<project>/npm-dev.log`, where `project` comes from
that state. Inspect only relevant, non-secret log lines.

Assert the slice's expected visible state, not just a successful click or
navigation. Retain its non-secret logs and evidence outside disposable data.

## Rust gateway

Follow [pp-verify's authenticated gateway flow](../pp-verify/SKILL.md#rust-gateway).
Keep launcher stdout/stderr in a private log. Wait for `PP_SERVER_URL` there,
not merely for a successful build.

Assert the slice's result through that authenticated context. A bare `401`
does not prove that the operation works. Record the shutdown and cleanup
outcome along with the result.

## Report

Record executed journeys and assertions, runtime owner, flag mode, exact HEAD,
duration, log location, screenshots, and cleanup outcome. For persistence
changes, include restart/recovery and stable IDs. For ownership changes,
include refusal by the non-owner and prove there was no second mutation.
Report missing browser/native/display tools as BLOCKED, never as a pass.
Follow the existing PR evidence rules; do not upload files without checking
them for credentials, customer data, and unrelated windows.
