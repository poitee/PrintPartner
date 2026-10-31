---
name: pp-verify
description: Run Print Partner and capture screenshot or video evidence for a web UI or desktop change. Use before opening or updating a PR that touches web/apps/web or rust/crates/pp-desktop.
---

# Verify a Print Partner change

The Evidence lint fails a PR that changes the web UI or desktop app unless Evidence has an HTTPS screenshot or video. Mocked tests passing does not show that the screen works. Run the real app at the PR head and look at it.

## Web UI

Use the repository helper. Give each run its own state, evidence, and data folders and two free loopback ports:

```sh
(
  set -eu
  : "${API_PORT:?pick a free loopback port}" "${UI_PORT:?pick a different free port}"
  ROOT="$(mktemp -d)"
  export PP_VERIFY_STATE_DIR="$ROOT/state" PP_VERIFY_EVIDENCE_DIR="$ROOT/evidence"
  trap 'node scripts/verify-print-partner/control-print-partner.mjs cleanup' 0
  node scripts/verify-print-partner/control-print-partner.mjs launch \
    --mode npm --data-dir "$ROOT/data" --api-port "$API_PORT" --ui-port "$UI_PORT"
  node scripts/verify-print-partner/control-print-partner.mjs doctor
  node scripts/verify-print-partner/control-print-partner.mjs screenshot \
    --path /builds --out "$ROOT/evidence/builds.png" --wait 1500
)
```

- Screenshot each screen the change affects, in both themes (`--theme dark`) if styling changed.
- The helper opens and closes a fresh browser for each command. Do not chain its `click`, `snapshot`, and `screenshot` commands to capture an open dialog, dropdown, or other client-only state.
- For those states, keep the app running inside the launch block above and use the `agent-browser` skill. Set `AGENT_BROWSER_SESSION="${AGENT_BROWSER_SESSION:-$(agent-browser session id --scope worktree --prefix pp-verify)}"` and export it. Open `http://127.0.0.1:$UI_PORT/builds`, take a snapshot, interact, take another snapshot, and capture with `agent-browser screenshot "$ROOT/evidence/changed-state.png"`. Keep the same session throughout and close that session before the launch block exits. Do not reload between interaction and capture.
- Open the image and check that it shows the change itself, not just the page loading.
- The helper drives the Node server. For behavior served by Rust, launch the gateway with `python3 scripts/verify-rust-gateway/verify.py launch` and point the browser at its origin.

## Desktop app

Follow [Desktop and tray capture](../../../docs/contributing/gate-evidence.md#desktop-and-tray-capture): build `pp-desktop` at the PR head, run it on the evidence display, then capture with `evidence shot window --window "Print Partner"`, `evidence shot tray --tray`, or `evidence record <name> <seconds>` for a video.

## Attach the evidence

1. Open every file and check it shows only the app: no terminals, other windows, tokens, or customer data. The repository is public.
2. Upload with `evidence publish <pr-number> <files...> --note "<what it shows>"`. It pushes to `evidence/<branch>` and comments the image links on the PR. Without that tool, drag the files into the PR description on GitHub.
3. Put the links under `## Evidence` with the head SHA and one line per image saying what it shows.

When a change under those paths has no visible effect, such as a type-only refactor, say why on the `Exemption:` line instead.
