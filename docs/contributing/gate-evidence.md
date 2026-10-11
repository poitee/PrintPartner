# Gate evidence

The PR template keeps `Exemption:` and all verification fields inside one
`## Evidence` section. With `Exemption: none`, fill these exact labels:

- `Steps followed to produce the evidence:` with the actions you performed.
- `Result observed:` with the actual outcome.
- `Screenshot / recording / verify-skill output or trace:` with a concrete
  artifact, such as a screenshot URL, `evidence/trace.json`, or the backticked
  command `node --test scripts/lint-pr-evidence.test.mjs` and its output.

`Journey exercised:` provides context but cannot replace those fields. An
artifact can also be cited outside the fields within Evidence. Bare category
words such as `screenshot` or `trace` do not count as artifacts. Whitespace,
HTML comments, TODO, TBD, FIXME, and unfilled prompts do not supply evidence.

If claiming an exemption, replace `none` with `docs-only`, `ci-only`,
`dependency-only`, or `internal refactor`, and fill `Exemption reason:`.
Indent every continuation line under that bullet. An arbitrary reason on the
`Exemption:` line is not a valid category.

Verification content must not target Chad's LAN instances (`192.168.*.80` or
`.81`), including link destinations and document-wide reference destinations.
Use a disposable local verify instance. LAN mentions are allowed only on the
Exemption line or inside a properly indented Exemption reason.

The Evidence section ends at the next level-one or level-two heading. Fenced
output can accompany the required fields and concrete artifact citation.

## CI and local checks

`.github/workflows/pr-evidence.yml` runs the tests and body lint on
`pull_request_target` events, including body edits. It executes the protected
base SHA's checker with read-only permissions, so enforcement starts after
the workflow and checker land on the base branch.

```sh
node --test scripts/lint-pr-evidence.test.mjs
node scripts/lint-pr-evidence.mjs --body-file body.md
```

The checker also accepts `PR_BODY` or `--stdin`.
