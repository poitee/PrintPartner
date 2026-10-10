# Gate evidence

> User-visible pull requests must attach or link evidence from the real running app, not mocks or stubs, and include the steps followed to produce it in the PR's Evidence section. Gate returns **FAIL** without this evidence unless one of the four exemptions below applies. Automated verification must never target Chad's LAN instances (.80/.81).

"User-visible" means any change to the UI, routes, printer actions, or the
desktop shell.

Accepted evidence includes:

- A screenshot showing the changed behavior.
- A recording of the affected journey.
- Verify-skill output or a trace demonstrating the result.

Put evidence in the PR body's **Evidence** section (see
`.github/pull_request_template.md`). Attach files or link to screenshots,
recordings, verify output, or trace artifacts from the real running app, not
mocks or stubs. Include the steps followed to produce the evidence and the
result observed. Automated verification must never target Chad's LAN instances
(.80/.81).

The only exemptions are exactly these four:

- docs-only
- CI-only
- dependency-only
- internal refactor with no user-visible change

Authors must either attach or link evidence and set `Exemption: none`, or name
one of these four exemptions in the Evidence section and explain why it applies
in the **Exemption reason** field. Use `Exemption: internal refactor` only when
there is no user-visible change.

## CI enforcement

The GitHub Actions workflow `.github/workflows/pr-evidence.yml` runs a
lightweight lint on every pull request body:

- Fail when the `## Evidence` section is missing.
- Fail when `Exemption: none` lacks Steps followed, Result observed, and a
  Screenshot/recording/verify-skill artifact (a journey name alone is not
  enough; Exemption reason text does not count as evidence).
- Fail when `Exemption:` is still the template placeholder, unknown, or a named
  exemption without a non-empty reason.
- Fail when verification evidence fields target Chad's LAN instances
  (`192.168.*.80` / `*.81`). Named exemptions may mention those hosts without
  using them as verify targets.

Local check:

```bash
PR_BODY="$(cat body.md)" node scripts/lint-pr-evidence.mjs
node --test scripts/lint-pr-evidence.test.mjs
```

Gate returns **FAIL** if the evidence or a valid named exemption is missing, or
if automated verification targets Chad's LAN instances (.80/.81).
