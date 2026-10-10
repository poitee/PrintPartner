# Print Partner — agent guide

Pointers for coding agents in this repo. Detail lives under [`docs/agents/`](docs/agents/) and [`.agents/skills/`](.agents/skills/).

## Before you change code

- Read [`.agents/CONTEXT.md`](.agents/CONTEXT.md) for product vocabulary.
- Use [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md) for GitHub issues and pull requests.
- Run `cd web && npm run quality` before opening a PR ([README](README.md)).

## Gate: user-visible pull requests

Gate rule:

> User-visible pull requests must include verify-skill evidence (Playwright trace and/or screenshots). If a PR changes user-visible behavior in the Print Partner app and its description lacks that evidence, Gate returns **FAIL**.

Treat a PR as **user-visible** when it changes behavior a user can see or reach in the desk-loop UI (Library → Builds → Sources → Plan → Production ↔ Checkoff) or an equivalent product surface.

### Where verification evidence goes

In the pull request body, add a **`## Verification evidence`** section (see [`.github/pull_request_template.md`](.github/pull_request_template.md)):

- Name the journey exercised and the result you observed.
- Attach trace files and/or screenshots, or link to them (artifact, gist, or paths from the verify run).

Verify with:

- [`.cursor/skills/verify-print-partner/SKILL.md`](.cursor/skills/verify-print-partner/SKILL.md) — isolated Docker desk loop on `127.0.0.1:8080`; artifacts under `/tmp/pp-verify-evidence/<runId>/`.
- [`.agents/skills/verify-printpartner/SKILL.md`](.agents/skills/verify-printpartner/SKILL.md) — local npm UI/API verification.

If the change is not user-visible, say so in the PR so reviewers do not expect UI traces.

## Merge-ready pull requests

Follow [`.agents/skills/autopilot/SKILL.md`](.agents/skills/autopilot/SKILL.md) when babysitting a PR (`/autopilot`).
