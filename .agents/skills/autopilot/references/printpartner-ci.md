# Print Partner CI map

Use the failing check name from `pr-state.mjs` to pick the narrowest local command. Run from the repository root unless noted.

## Required checks

| GitHub check | What it runs | Narrowest local command |
| --- | --- | --- |
| Web CI / `web` | lint, typecheck, unit tests, workflow-smoke, build, browser tests | From `web/`: the specific workspace test that failed. Blast radius: `npm run test -w @print-partner/server` or `npm run test -w @print-partner/web`. Full gate: `npm run quality` |
| Web CI / `docker` | Compose validation, image build, container `/health`, `web/scripts/workflow-smoke.sh` | `docker compose config` and `./web/scripts/workflow-smoke.sh` against an isolated container |
| Validate manifests / `schema` | Manifest fixtures plus embedded-copy drift | `python -m unittest manifests.tests.test_validate` then `python manifests/scripts/validate.py` |

## Optional checks

| GitHub check | Narrowest local command |
| --- | --- |
| Optional integration smoke / `postgres` | Follow `.github/workflows/integration-smoke.yml`; do not invent a substitute |

## Autopilot helper

After changing this skill or `scripts/pr-state.mjs`:

```bash
node --test scripts/autopilot-pr-state.test.mjs
```

## Rules

- Read the failing job log before matching a row above.
- Do not edit `.github/workflows/` to silence a failure.
- `npm run quality` from `web/` is the full Web CI equivalent. Use it only when the failure is broad or you cannot isolate a workspace.
