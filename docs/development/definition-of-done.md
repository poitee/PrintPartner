# Definition of done

Every pull request meets this bar before it merges. The [pull request template](../../.github/pull_request_template.md) repeats it as a checklist.

## The bar

1. **One job per PR.** Keep the diff under about 1,500 lines. If you find work that belongs to another ticket, note it on that ticket and leave it out of this PR.
2. **Unslopped.** Run the unslop pass on code, comments and docs before review. Remove filler comments, dead code and speculative abstractions.
3. **Reviewed.** Factory Droid's automatic review runs on the exact head commit, every review thread is resolved, and required CI is green on that commit.
4. **Docs in the same PR.** When the PR changes behavior, setup or an interface, update the matching page under `docs/` in the same PR.

## Review and merge policy

- P0 and P1 findings block the merge. Fix them in the PR.
- A P2 that affects real user data, security, or causes a crash becomes a bug ticket in its chunk.
- Every other P2 and all P3s go on the post-parity polish list (GRE-974) or in a PR comment. Do not create a ticket for them.
- Never create "follow-ups from PR #..." tickets. Only create tickets for bugs on main, P0/P1 findings, or splits the parent ticket already calls for.
- After the first review, a PR gets at most two fix rounds. If new P0/P1 findings still appear, stop. Post an escalation comment on the ticket with the findings and two or three options (split the PR, replace custom code with a maintained library or standard tool, or defer), then pick other work.
- Prefer maintained libraries and standard platform mechanisms over custom hardening. Examples are OS file locks, CODEOWNERS, actionlint and zizmor.
- Merge with a squash commit. Write `Refs GRE-xxx` for a partial slice. Write `Fixes GRE-xxx` only in the PR that completes the ticket.

## Code review

`.github/workflows/droid-review.yml` runs Factory Droid code and security review on every ready PR and on each new push. Its `droid-review` job is a required check, and the main ruleset requires review threads to be resolved, so an open finding blocks the merge. Fix the finding, or reply with the reason it does not apply and resolve the thread. Critical and high security findings also request changes.

Mention `@droid` in a PR or issue comment to ask Droid a question or request another review (`.github/workflows/droid.yml`).

## Parity scope

- Match Node on real data and on everything Node's own code writes.
- Divergence on inputs the app or a user would not produce (exotic Unicode, V8 or js-yaml quirks, generated differential cases) is listed in `docs/desktop-rebuild.md` as a known difference, not fixed.
- Resource limits are simple caps: file size, depth, item count, a timeout. No per-allocation budget accounting.
- Print Partner is single-user. Do no tenant-isolation or multi-user contract work.

## Work in progress

- At most 2 tickets in flight per agent. If about 10 are already In Review across the project, help land those before opening new PRs.
- Fold small fixes into the next PR that touches the same code. Aim for 300 to 1,500 changed lines.

## Evidence

Put verification output under `## Evidence` in the PR body. The `Lint Evidence block` CI check fails when that section is empty and the `Exemption:` line gives no reason. A PR that changes the web UI or desktop app also needs a screenshot or video under Evidence. [Gate evidence](../contributing/gate-evidence.md) describes the check and the desktop capture steps.
