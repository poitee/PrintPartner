## Summary

<!-- What changed and why -->

## Evidence

<!-- REQUIRED: Either attach/link evidence and set Exemption: none, or name exactly one of the four exemptions below and explain why it applies. Gate returns FAIL without evidence or a valid named exemption. CI job "PR evidence" enforces this on every PR. See docs/contributing/gate-evidence.md.
"User-visible" means any change to the UI, routes, printer actions, or the desktop shell.
Evidence must come from the real running app, not mocks or stubs, and must include the steps followed to produce it.
For UI/desktop changes include screenshots or a recording plus verify output when available.
The only exemptions are docs-only; CI-only; dependency-only; internal refactor with no user-visible change.
Automated verification must never target Chad's LAN instances (.80/.81); Gate returns FAIL if it does. -->

Exemption: <none|docs-only|CI-only|dependency-only|internal refactor>

- Exemption reason (required when claiming an exemption):

- Journey exercised:
- Steps followed to produce the evidence:
- Result observed:
- Screenshot / recording / verify-skill output or trace: <!-- attach files or paste links -->

## Test plan

- [ ] `cd web && npm run quality` (or note narrower checks run)
- [ ] `node --test scripts/lint-pr-evidence.test.mjs` (when touching the evidence lint)
