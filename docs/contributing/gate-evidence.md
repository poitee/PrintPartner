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
- Fail when `Exemption: none` lacks Steps followed (nested bullets are fine),
  Result observed, and a concrete artifact: a URL, a file path such as
  `trace.json`, a Markdown link or image, or inline code. A journey name, a bare
  category word such as `screenshot`, and Exemption reason text do not count.
- Fail when `Exemption:` is still the template placeholder, unknown, or a named
  exemption without a non-empty reason.
- Fail when any verification content (Journey, Steps, Result, artifact, or other
  freeform text in the section) targets Chad's LAN instances
  (`192.168.*.80` / `*.81`). This applies to named exemptions too. Mention those
  hosts only in the Exemption reason.
- HTML comments and fenced code blocks are ignored, so commented-out or example
  Evidence sections do not count. Put real output in a linked file or inline code.

Local check:

```bash
PR_BODY="$(cat body.md)" node scripts/lint-pr-evidence.mjs
node --test scripts/lint-pr-evidence.test.mjs
```

Gate returns **FAIL** if the evidence or a valid named exemption is missing, or
if automated verification targets Chad's LAN instances (.80/.81).
