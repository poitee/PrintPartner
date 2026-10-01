# Print Partner CI map

Use the failing check name from `pr-state.mjs` to pick the narrowest local command. Run from the repository root unless noted.

## Required checks

| GitHub check | What it runs | Narrowest local command |
| --- | --- | --- |
| Web CI / `web` | high-severity dependency audit, lint, typecheck, unit tests, workflow-smoke, build, bundle checks, runtime checks, browser tests | From `web/`: the specific workspace test that failed. Blast radius: `npm run test -w @print-partner/server` or `npm run test -w @print-partner/web`. Application suite: `npm run quality`. Separate dependency check: `npm audit --audit-level=high` |
| Web CI / `docker` | Compose validation, image builds, sidecar unit tests, container `/health`, `web/scripts/workflow-smoke.sh` | `docker compose config` and `./web/scripts/workflow-smoke.sh` against an isolated container. Run sidecar tests in the built image as shown in `.github/workflows/web-ci.yml`. |
| Validate manifests / `schema` | Manifest fixtures plus embedded-copy drift | `python -m unittest manifests.tests.test_validate` then `python manifests/scripts/validate.py` |

## Optional checks

| GitHub check | Narrowest local command |
| --- | --- |
| Optional integration smoke / `postgres` | Follow `.github/workflows/integration-smoke.yml`; do not invent a substitute |

## Rules

- Read the failing job log before matching a row above.
- Do not edit `.github/workflows/` to silence a failure.
- `npm run quality` from `web/` runs the application quality suite. Use it only when the failure is broad or you cannot isolate a workspace. The dependency audit, Docker checks, and manifest checks run separately.
