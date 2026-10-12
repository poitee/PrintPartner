# Gate evidence

The PR template provides `## Evidence` and `## Exemption` sections.
Put verification output or a description of what you checked under Evidence.
Use `Exemption: none` when providing evidence. If evidence is unavailable,
write a reason directly on the `Exemption:` line; no category is required.

The lint fails only when Evidence is empty or missing and no exemption reason
is given. Whitespace, HTML comments, and unfilled template placeholders
(`<...>`, TODO, TBD, FIXME, or placeholder prompts) count as empty.
An absent or empty `Exemption:` line, `none` (case-insensitive), or an unfilled
placeholder does not provide a reason. Exemption metadata does not itself
count as evidence. The Evidence section ends at the next level-one or
level-two heading; fenced output can be included as evidence.

The lint does not require Steps/Result fields or artifacts and does not check
hosts. Those removed requirements are tracked in
[GRE-583](https://linear.app/greetz/issue/GRE-583).

## CI and local checks

`.github/workflows/pr-evidence.yml` runs the tests and body lint on
`pull_request_target` events, including body edits. It executes the protected
default branch's checker with read-only permissions. This keeps the same
repository evidence policy for stacked PRs whose base branches predate the
checker. The PR body enters the checker through an environment variable;
the workflow never checks out or executes the PR head.

```sh
node --test scripts/lint-pr-evidence.test.mjs
node scripts/lint-pr-evidence.mjs --body-file body.md
```

The checker also accepts `PR_BODY` or `--stdin`.
