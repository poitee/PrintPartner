# Print Partner verification map

This directory is the maintained source for verifying Print Partner's user-facing
desk-loop behavior. Read this index before driving the app, then use the matching
feature file as the recipe.

## Baseline preconditions

- Launch with `node .cursor/skills/verify-print-partner/helpers/control-print-partner.mjs launch --mode docker`
  (fallback: `--mode npm`).
- Desk-loop surface for Docker verification is `http://127.0.0.1:8080`.
- Run `… doctor` and require health `ok`, owned project, and disposable data dir.
- Never drive Chad's LAN `192.168.200.80:8080` from a cloud agent — that path is
  documented separately in [live-lan-walk.md](./live-lan-walk.md).
- Never aim `web/scripts/workflow-smoke.sh` at a persistent developer volume.
- Put `CONTROL` on your shell as the control helper invocation from `SKILL.md`.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer ARIA roles and accessible names over CSS selectors or DOM position.
- Treat every command as literal.
- Restore or discard disposable fixture Builds after mutation. Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA snapshot and a screenshot with Print Partner chrome visible.
- Mutation proof includes a second read (reload or API) of the stored value.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the
user-visible behavior. It then uses exactly four H2 sections in this order:

1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it with control-print-partner`
4. `Gotchas`

## Features

- [Source Library and Build Sources](./sources.md) — Library registry vs per-Build attach.
- [Plan](./plan.md) — files, quantities, and colors; accept a Plan revision.
- [Checkoff](./checkoff.md) — verify units against an Accepted Plan.
- [Production](./production.md) — plates, export, and printer handoff.
- [Theme (instrument chrome)](./theme.md) — light / dark / system preference.
- [Live LAN walk (human/Mac)](./live-lan-walk.md) — separate evidence path; not cloud-reachable.
