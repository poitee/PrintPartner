---
name: verify-print-partner
description: >
  Drive Print Partner's desk-loop web UI (Library → Builds → Sources → Plan →
  Production ↔ Checkoff) the way a user does. Use after implementing
  user-visible behavior, for end-to-end proof, or when asked to verify Print
  Partner — not for "CI green alone." Prefer the isolated Docker instance on
  :8080; never aim verification at Chad's LAN 192.168.200.80. Use focused
  tests alone for changes with no observable app behavior.
---

# Verify Print Partner

Prove changed behavior through the desk-loop surface a user reaches. Keep every
verification run isolated from developer and LAN data.

Control helper (machine-readable JSON on stdout):

```bash
node .cursor/skills/verify-print-partner/helpers/control-print-partner.mjs <command> [options]
```

Alias used below: `CONTROL="node .cursor/skills/verify-print-partner/helpers/control-print-partner.mjs"`

## Choose the proof

Identify the shortest user journey that exercises the change and its likely regression boundary. Use one or more of these existing harnesses:

- Focused tests: run the relevant workspace test from `web/`.
- Full repository gate: run `npm run quality` from `web/` when the change is broad or the user requests release-level proof.
- API workflow: run `web/scripts/workflow-smoke.sh` against an isolated running app when the behavior crosses backend workflow stages.
- Browser journey: drive the Vite app at `http://127.0.0.1:5173` with browser automation when the behavior is visible or interactive. Existing browser checks run through `npm run test:browser` from `web/`.

Prefer direct observation of the changed behavior over a broad test suite that only passes nearby code.

## Launch

Start an isolated Print Partner on **127.0.0.1:8080** with a disposable data directory
(never the default `print-partner-data` volume, never `192.168.200.80`).

```bash
$CONTROL launch --mode docker
# Ready when doctor passes. Reuses a healthy prior run from this state file.
# Fallback when Docker is unavailable in the agent VM:
$CONTROL launch --mode npm
```

- Docker mode builds/runs `helpers/compose.verify.yml` under project `pp-verify-<id>`,
  bind-mounts `PP_VERIFY_DATA_DIR`, publishes **127.0.0.1:8080**.
- npm mode starts `web/` `npm run dev` with `PRINT_PARTNER_DATA_DIR` set to the
  disposable dir (UI `:5173`, API `:18765`). Prefer Docker — that matches the
  documented desk-loop surface.
- State: `/tmp/pp-verify/state.json` (override with `PP_VERIFY_STATE_DIR`).
- Evidence root: `/tmp/pp-verify-evidence/<runId>/` (override with
  `PP_VERIFY_EVIDENCE_DIR` or `--evidence-dir`). **Cleanup never deletes evidence.**

Ready signal: `GET <baseUrl or healthUrl>/health` returns JSON `{ "ok": true }`.

## Run an isolated app

Prefer the control helper above. When using the existing API or browser harnesses
directly, the manual startup procedure is:

1. Create a unique temporary data directory with `mktemp -d` and retain its exact path for cleanup.
2. From `web/`, start the API with `PRINT_PARTNER_DATA_DIR` set to that directory, `HOST=127.0.0.1`, and `PORT=18765`.
3. Start the Vite client from `web/`; its proxy targets `http://127.0.0.1:18765` by default.
4. Wait until `http://127.0.0.1:18765/health` succeeds before driving the UI or workflow script.

Use existing dependencies when present. If dependencies or a Chrome/Chromium executable are missing, report the prerequisite or request authorization for installation when installation is in scope. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can point the existing browser harness at an available executable.

Use only the temporary data directory for writes. Treat an already-running app as developer-owned unless the user explicitly authorizes using it.

Keep evidence outside the disposable data directory so cleanup preserves it.
Manual runs use direct browser automation or the API harness, not helper commands
that require launch state. Record the processes you start for cleanup.

## Doctor

Read-only check that this instance is worth driving:

```bash
$CONTROL doctor
```

Requires: health `ok`, UI reachable at `baseUrl`, compose project running (Docker)
or process alive (npm), disposable `dataDir` present, evidence dir present.
For helper-driven verification, refuse to drive any instance that was not started
by this skill's `launch`. For manual runs, confirm the owned processes, temporary
data directory, health, and UI reachability before driving the app directly.

## Drive

Prefer Playwright via the control helper (uses `playwright-core` from `web/` plus
system Chrome / `PLAYWRIGHT_CHROMIUM_EXECUTABLE`). Existing focused harnesses remain
available (`cd web && npm run test:browser`, `BASE=… ./web/scripts/workflow-smoke.sh`)
for API workflow proof — never aim `workflow-smoke.sh` at persistent LAN data.

```bash
# Open Source Library (instrument chrome + workshop heading)
$CONTROL navigate --path /library --theme dark
$CONTROL snapshot --path /library --out "$EVIDENCE/library.aria.txt"
$CONTROL screenshot --path /library --out "$EVIDENCE/library.png"

# Theme control (Settings → Appearance / header Theme group)
$CONTROL theme --preference dark --out "$EVIDENCE/theme-dark.png"

# Click by role + accessible name
$CONTROL click --path /builds --role link --name "Source Library"
```

Stable handles (from current UI):

| Surface | Path | Observable |
|---------|------|------------|
| Source Library | `/library` | heading `Source Library` |
| Builds | `/builds` | heading `Builds`; button `New Build` |
| Build Sources | `/sources?profile=<id>` | heading `Sources`; `Attach from Library` |
| Plan | `/plan?profile=<id>` | heading `Plan`; owns files / qty / colors |
| Production (Build) | `/export?profile=<id>` | heading `Production` |
| Checkoff | `/progress?profile=<id>` | heading `Checkoff`; requires Accepted Plan units |
| Settings / Theme | `/settings` | group `Theme` (`system` \| `light` \| `dark`) |

Instrument look = design language (graphite + signal cyan). Theme preference is
`system` / `light` / `dark` in `localStorage["print-partner.theme"]` — not a third
named "instrument" mode.

Read `features/` before driving. Drive the mapped entry points for the feature
under test; one convenient shortcut does not cover the map.

## Exercise the journey

Drive the real UI for user-visible changes. Interact through roles, labels, and visible text where possible. Verify the resulting UI state and, when relevant, confirm persisted state after a reload or through the API.

For API workflow proof, set `BASE` to the isolated server URL before running `web/scripts/workflow-smoke.sh`. The script creates sources, builds, plans, progress, and exports, so never aim it at persistent developer or production data.

Capture screenshots for visual claims when browser tooling supports them. Store temporary evidence outside the repository unless the user requests committed artifacts.

## Evidence

Proof standards:

1. Exercise the real user path (nav / stage links / buttons), not internal setters.
2. Capture the action and the resulting state (ARIA snapshot + screenshot with app chrome).
3. For mutations, confirm persistence (reload or second view / API read).
4. Store artifacts under the run's `evidenceDir` (from launch JSON). Copy keepers into
   `/opt/cursor/artifacts/` for PR walkthroughs when running as a cloud agent.

```bash
EVIDENCE=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/pp-verify/state.json','utf8')).evidenceDir)")
$CONTROL screenshot --path /library --out "$EVIDENCE/library.png"
$CONTROL snapshot --path /library --out "$EVIDENCE/library.aria.txt"
```

Doc screenshot helper (optional, same Playwright pattern):
`node docs/scripts/capture-screenshots.mjs --url http://127.0.0.1:8080 --theme dark`

## Cleanup

Tear down only what this run started. **Never delete the evidence directory.**

```bash
$CONTROL cleanup
# Confirm evidence survived:
test -d "$EVIDENCE" && ls "$EVIDENCE"
```

- Docker: `docker compose -p <project> -f helpers/compose.verify.yml down --volumes`
- npm: SIGTERM the process group recorded in state
- Removes disposable `dataDir`; retains `evidenceDir`
- Never kill by process name; never stop an unrelated Compose project

## Finish

Stop only the processes started for this verification. Remove the temporary data directory only after checking that its resolved path is the unique directory created for this run.

Report:

- the exact journey exercised;
- the observed result at the user boundary;
- commands or automation used;
- any unverified portion and its concrete blocker.

A passing test without observing the requested user behavior is incomplete when that behavior can be driven locally.

## Helpers

| Path | Role |
|------|------|
| `helpers/control-print-partner.mjs` | launch / doctor / navigate / snapshot / screenshot / click / theme / cleanup |
| `helpers/compose.verify.yml` | Isolated Compose service on 127.0.0.1:8080 with bind-mounted data |
| `features/` | Maintained feature map (Sources, Plan, Checkoff, Production, theme, live LAN walk) |

```bash
$CONTROL help
```

## Feature map

See [features/README.md](features/README.md). Cloud agents cannot reach
`192.168.200.80:8080` — use Docker here; use [features/live-lan-walk.md](features/live-lan-walk.md)
only as a human/Mac checklist on the LAN desk loop.

## Maintenance

When routes or labels drift, run `/maintain-verification-skill` and update the map.
