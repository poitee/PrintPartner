# Definition of done

Every pull request meets this bar before it merges. The [pull request template](../../.github/pull_request_template.md) repeats it as a checklist.

## The bar

1. **One job per PR.** Keep the diff under about 1,500 lines. If you find work that belongs to another ticket, note it on that ticket and leave it out of this PR.
2. **Unslopped.** Run the unslop pass on code, comments and docs before review. Remove filler comments, dead code and speculative abstractions.
3. **Independently verified.** A reviewer from a different model vendor than the author reviews the exact head commit. CI is green on that commit.
4. **Docs in the same PR.** When the PR changes behavior, setup or an interface, update the matching page under `docs/` in the same PR.

## Review and merge policy

- P0 and P1 findings block the merge.
- P2 and P3 findings become follow-up Linear tickets. They do not start another review round.
- After the first review, a PR gets at most two fix rounds. If new findings still appear, stop. Post an escalation comment on the ticket with the findings and two or three options, then pick other work. Typical options are:
  - Split the PR.
  - Replace the custom code with a maintained library or a standard tool.
  - Defer the work.
- Prefer maintained libraries and standard platform mechanisms over custom hardening. Examples are OS file locks, CODEOWNERS, actionlint and zizmor.
- Merge with a squash commit. Write `Refs GRE-xxx` for a partial slice. Write `Fixes GRE-xxx` only in the PR that completes the ticket.

## Evidence

Put verification output under `## Evidence` in the PR body. The `Lint Evidence block` CI check fails when that section is empty and the `Exemption:` line gives no reason. [Gate evidence](../contributing/gate-evidence.md) describes the check and the desktop capture steps.
