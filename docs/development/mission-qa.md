# Bounded QA for Print Partner Missions

Use existing tools rather than install another QA framework. Read [Missions readiness](missions-readiness.md) for the current/target distinction and [CI](ci.md) for prerequisites and the canonical check inventory.

Commands below assume the checkout root and a POSIX shell. The gateway helper uses Unix facilities; these recipes are not Windows native acceptance.

## Choose the smallest relevant proof

| Change or question | Check | What it does not prove |
|--------------------|-------|------------------------|
| Instructions/documentation | `just guidance`, documented command names/flags, and `git diff --check`. | Product behavior or a passing hosted CI run. |
| Rust library | Formatting, affected-crate tests, and the applicable local CI IDs; exercise flag-off/on for migration paths. | Runtime wiring, UI, installed lifecycle, or cutover. |
| Web/Node code | Package lint/typecheck and focused tests, then the isolated browser harness below. | That the corresponding operation runs in Rust. |
| Rust gateway/compatibility boundary | `verify.py verify` or bounded `launch --binary` plus explicit assertions. | Native Tauri interaction, all-Rust ownership, or full parity. |
| Native desktop, printer, or external slicer | Platform-specific installed journeys and simulator/fixture proofs from the owning issue. | Real hardware behavior when only a simulator ran. Do not send a real print as a smoke test. |
| Legacy sidecar | Relevant Python/slicer checks only when that code changes. Report missing pytest/Orca/native prerequisites. | A need to expand legacy slicing in the Rust product. |

Discover current entrypoints without installing dependencies or running suites:

```sh
python3 scripts/local-ci.py --list
node scripts/verify-print-partner/control-print-partner.mjs help
python3 scripts/verify-rust-gateway/verify.py --help
```

Use `--only`/`--skip` IDs from the local CI plan. The wrapper can exit zero with skipped checks, and does not cover every hosted/web/native/release check. Before push, follow the complete applicable CI process, not just a smoke selector.

For test selection, inspect the affected package scripts and test names. Record **executed counts**; an exact Rust selector can match zero tests and still exit successfully. Vitest/pytest collection proves discovery only. Do not run an entire `npm test`, workspace nextest suite, or heavy slicer journey for a bounded readiness probe without budgeting it.

## Isolated Node/browser smoke

Prerequisites: the appropriate Node installation and `npm --prefix web ci`, plus a browser usable by the repository's `playwright-core` helper. See its `browserExecutable` selection for supported executable paths/overrides. Do not assume a globally installed `agent-browser` or a display server.

Give each run its own `PP_VERIFY_STATE_DIR`, `PP_VERIFY_EVIDENCE_DIR`, disposable data folder, and two unused loopback ports. In npm mode, pass `--api-port` and `--ui-port`; do not reuse the default ports if occupied. Keep the same environment for every command in the run. Do not point this helper at a user's installation.

Set `QA_API_PORT` and `QA_UI_PORT` to two different unused ports, then use this sequence. The subshell creates fresh state/data/evidence paths and cleans up even when launch or a later step fails:

```sh
(
  set -eu
  : "${QA_API_PORT:?Choose an unused loopback API port}"
  : "${QA_UI_PORT:?Choose a different unused loopback UI port}"
  QA_ROOT="$(mktemp -d)"
  export PP_VERIFY_STATE_DIR="$QA_ROOT/state"
  export PP_VERIFY_EVIDENCE_DIR="$QA_ROOT/evidence"
  printf 'QA artifacts: %s\n' "$QA_ROOT"
  trap 'node scripts/verify-print-partner/control-print-partner.mjs cleanup --keep-data' 0
  trap 'exit 130' INT
  trap 'exit 143' TERM
  node scripts/verify-print-partner/control-print-partner.mjs launch \
    --mode npm --data-dir "$QA_ROOT/data" \
    --api-port "$QA_API_PORT" --ui-port "$QA_UI_PORT"
  node scripts/verify-print-partner/control-print-partner.mjs doctor
  node scripts/verify-print-partner/control-print-partner.mjs navigate --path /builds
  node scripts/verify-print-partner/control-print-partner.mjs click \
    --role link --name '^Settings$' --path /builds
  node scripts/verify-print-partner/control-print-partner.mjs snapshot --path /settings
)
```

Record each step's result and the cleanup result. The final snapshot supports a destination-state assertion; it is not an automatic acceptance test. `--keep-data` avoids deleting the fixture during cleanup; retain or remove only your own generated artifacts under the applicable authorization.

Assert the expected URL **and rendered destination state**, not just that a click succeeded. The historical Settings smoke reached `/settings` but retained a stale heading in the immediate response; it was not proof of fully rendered Settings behavior. Add a destination snapshot/assertion for acceptance.

The Node server's `/health` and `/api/v1` can confirm basic availability. They do not establish Rust ownership, and must not be confused with the Rust gateway's authenticated health endpoint.

## Rust gateway proof

Prerequisites: the pinned Rust toolchain, native Node 24.21/npm, Python, and asset/build dependencies from the CI/building guides. The existing helper builds web assets, generates the measured bundle manifest, builds `pp-server`, and drives a private temporary instance:

```sh
python3 scripts/verify-rust-gateway/verify.py verify
```

This is a build-and-functional proof, not a unit-test shortcut. Budget it before running; it performs `npm ci` and a full asset build. Keep a non-secret command log with the exit status. The helper checks:

- unauthenticated `GET /health` returns 401;
- a private one-use bootstrap returns 303, then the session cookie authenticates `/health` and `/__runtime`;
- `GET /builds` with `Accept: text/html` serves the React root;
- a Source mutation can be read back from the isolated instance;
- shutdown removes reservations/private sockets and permits reacquiring the data lock.

This still includes a Node compatibility worker. A successful request is not proof that its operation has migrated to Rust.

For bounded browser work against an already-built matching checkout:

```sh
python3 scripts/verify-rust-gateway/verify.py launch \
  --binary "$PP_SERVER_BINARY" --credential-file "$QA_PRIVATE_CREDENTIAL"
```

`PP_SERVER_BINARY` must be the absolute path to a binary built for this checkout and its current `rust/bundle-manifest.json`. Choose a non-existing credential filename in a private directory. The helper runs until signaled; stop the owned helper with SIGTERM in `finally` and verify its exit/shutdown evidence.

Never print the credential JSON, bootstrap URL, cookie, or token. Use the exact emitted origin and do not auto-follow bootstrap redirects when inspecting the 303/Set-Cookie exchange. Request browser documents with `Accept: text/html`; a bare request can legitimately return 404.

Let the helper create its safe temporary data directory. A repository-nested `TMPDIR` can fail ancestor permission checks; do not chmod repository/home ancestors or weaken storage security to make the test pass.

## Evidence and blockers

Record commit and dirty state, flags, runtime/OS/tool versions, command, selector, executed count or assertion, duration, exit code, and non-secret artifact paths. Keep evidence outside tracked source, for example in ignored `.audit/` scratch. Redact logs and screenshots before sharing.

Report missing tools, displays, SDKs, signing access, and timeouts as blockers, not passes. Native macOS packaging/permissions, Windows/Linux lifecycle support, external Orca handoff, and three-OS CI need their own receipts. A browser proof or documented fallback cannot replace them.

Use harness cleanup or signal the exact process you launched. Do not kill by a broad process-name match, remove user data, leave background servers running, or silently discard failed evidence.
