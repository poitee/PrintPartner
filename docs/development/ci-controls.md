# Change a CI workflow

This page covers review, linters, action pins and required checks for every workflow.
[Continuous integration](ci.md) describes the Rust cross-OS jobs, their exclusions and how to run them locally.

1. Open a pull request against `main` with the workflow change and its verification evidence.
2. Request review from Chad, `@poitee`, for any path listed in `.github/CODEOWNERS`.
3. Run actionlint 1.7.12 with ShellCheck and zizmor 1.31.1 before pushing.

   ```sh
   actionlint -color
   zizmor --config .github/zizmor.yml --min-severity informational .
   ```

   Use `zizmor --offline` for a local run without GitHub authentication.
   CI also runs the online audits with its read-only GitHub token.
4. Fix findings or document a narrow exception and its reason in `.github/zizmor.yml`.
5. Wait for the PR checks and the independent review on the final commit.
   Chad applies the repository rules described below and approves protected changes.

## Ownership and checks

CODEOWNERS assigns these paths to `@poitee`:

- `.github/CODEOWNERS`, `.github/workflows/`, and `.github/actions/`.
- `.github/dependabot.yml` and `.github/zizmor.yml`.
- `rust/scripts/check-*` and `rust/deny.toml`.
- The action pin, CI tool pin, desktop workflow, and workaround checks and their tests.
- The PR evidence checker and its test, the `scripts/linear/` directory, and the macOS bundle path filter.
  Linear PR sync runs a script from that directory with the Linear secret. Python imports files next to that script before the standard library.
- `scripts/release.mjs`, `web/scripts/atomic-package-build.mjs`, `Dockerfile`, and `docker-entrypoint.sh`, which the release workflow runs directly or builds into the published image.
- `rust/ast-grep-baseline.json`, `scripts/workaround-baseline.json`, and Rust snapshot directories under `rust/crates/`.

The `actionlint` and `zizmor` jobs in `.github/workflows/actionlint.yml` run on every `pull_request`.
There is no path filter or job condition, so a documentation-only PR reports both checks.
They also run on pushes to `main` and `master`, and on manual dispatch.
Both jobs have only `contents: read` permission and disable persisted checkout credentials.

Actionlint 1.7.12 checks workflow syntax and embedded shell commands with ShellCheck.
The job verifies the actionlint download against its SHA-256 checksum before execution.
It reports through the job exit status, so fork PRs do not need permission to create check runs.

Zizmor 1.31.1 uses the regular persona and fails on all reported severities, including informational findings.
There is no confidence filter.
This keeps low-severity notices visible without adding the pedantic persona's style checks.
The pinned `zizmor-action` runs online audits and emits job annotations without a SARIF upload or write permission.
Its default pin policy requires every external action, including `actions/*`, to use a full commit SHA.

## Existing findings

The first offline zizmor run reported twelve findings.
CI also found a version comment that did not match its pinned action.
The workflow and configuration changes handle them as follows:

| Finding | Resolution |
| --- | --- |
| `artipacked` in Desktop contracts | Set `persist-credentials: false` on checkout. |
| `template-injection` in Desktop WebKit | Pass the artifact URL through an environment variable before the shell command. |
| `dangerous-triggers` in PR evidence | Allow only the trigger line. Checkout runs trusted default-branch tooling. The PR body enters the checker through an environment variable. |
| `dangerous-triggers` in Linear PR sync | Allow only the trigger line. PR events run the immutable base commit. Scheduled runs use the default branch. The workflow never runs PR-head code. |
| Two `self-repository` notices in Release | Allow only the two local reusable-workflow lines. They resolve at the caller's commit. Actionlint 1.7.12 rejects zizmor's suggested `$/` replacement syntax. |
| Mismatched action version comment in Chain tip gate | Replace the moving `# v2` comment with the verified `# v2.87.27` tag. Keep the existing commit SHA. |
| `dependabot-cooldown` for GitHub Actions | Set a seven-day cooldown for action version updates. |
| Two other `dependabot-cooldown` notices | Keep the existing npm and pip update policies. Their cooldown policy needs separate review. Each entry has a line-specific exception. Zizmor 1.31.1 stops at the first entry with a cooldown, so it reports nothing for the Docker and Cargo entries after it. A zizmor upgrade that audits them needs the same review. |

Every exception has its reason in `.github/zizmor.yml` and requires the owner's review.
No audit rule is disabled.

## Update action pins

Dependabot already checks the `github-actions` ecosystem weekly at the repository root.
It opens pin updates with a seven-day cooldown for new action releases.
Review those PRs with the same checks and owner approval as a manual workflow change.

To update a pin manually:

1. Choose an upstream release and resolve its tag to the full 40-character commit SHA.
   If the tag is annotated, resolve the tag object to its commit.
2. Set `uses: owner/action@<commit>` and keep a version comment such as `# v1.2.3` on that line.
3. Review the upstream diff and rerun both linters.
4. To update actionlint itself, update the exact download version and checksum together.
   To update zizmor, change its exact `version` input and review the changed audits.

Run [`scripts/check-github-actions-pinned.sh`](../../scripts/check-github-actions-pinned.sh) from the repository root.
Web CI runs the same script. It exits with status zero when `unpinned=0`.

```sh
bash scripts/check-github-actions-pinned.sh
```

## Settings for Chad

CODEOWNERS requests review. GitHub enforces that review only after Chad enables the main-branch ruleset.
Before applying the proposed ruleset, agents must open and push PRs through a bot identity distinct from `poitee`, so Chad can approve them.
With `poitee` as the only collaborator, the unchanged rules block every PR he authors or last pushes. GitHub forbids self-approval.
Alternatively, Chad must add a bypass actor or relax the approval requirements before applying the ruleset. Either option changes its protections.

The GRE-635 PR contains the proposed ruleset JSON payload and the matching UI steps.
The intended required check names are `actionlint`, `zizmor`, `rust (linux)`, `rust (macos)`, and `rust (windows)`.

Apply that ruleset after this PR and GRE-632's three-OS CI land and report all five checks on `main`.
Require a PR with an approving review, code owner approval, dismissal of stale approvals, and approval of the latest push.
For the separate bot identity option, block force pushes and branch deletion, restrict merges to squash, and leave the bypass list empty, including for bots.
Keep other existing protections when adding these rules.

After applying the ruleset, use a bot-authored workflow PR to verify that GitHub blocks merging without Chad's approval.
Verify that a PR changing only documentation receives both lint checks.
GRE-635 stays open until the settings and those enforcement checks are complete.
