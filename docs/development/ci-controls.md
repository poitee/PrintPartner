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
   The applied ruleset and the pending review requirements are described below.

## Ownership and checks

CODEOWNERS assigns these paths to `@poitee`:

- `.github/CODEOWNERS`, `.github/workflows/`, and `.github/actions/`.
- `.github/dependabot.yml` and `.github/zizmor.yml`.
- `rust/scripts/check-*` and `rust/deny.toml`.
- The action pin, CI tool pin, desktop workflow, and workaround checks and their tests.
- The PR evidence checker and its test, and the `scripts/linear/` directory.
  Linear PR sync runs a script from that directory with the Linear secret. Python imports files next to that script before the standard library.
- `scripts/release.mjs`, `web/scripts/atomic-package-build.mjs`, `Dockerfile`, and `docker-entrypoint.sh`, which the release workflow runs directly or builds into the published image.
- `rust/ast-grep-baseline.json`, `scripts/workaround-baseline.json`, and Rust snapshot directories under `rust/crates/`.

The `actionlint` and `zizmor` jobs in `.github/workflows/actionlint.yml` run on every `pull_request`.
There is no path filter or job condition, so a documentation-only PR reports both checks.
They also run on pushes to `main` and `master`, and on manual dispatch.
Both jobs have only `contents: read` permission and disable persisted checkout credentials.

Actionlint 1.7.12 checks workflow syntax and embedded shell commands with ShellCheck. On PRs, actionlint and zizmor run when `.github/workflows/**`, `.github/actions/**`, either linter's configuration, or the CI filter script and its tests change. Their named jobs report skipped checks for other paths. Pushes and manual runs always execute both linters. New PR pushes cancel older runs; pushes to the default branch do not.
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
| `dependabot-cooldown` for every ecosystem | Set a seven-day cooldown on the GitHub Actions, npm, pip, Docker and Cargo entries. |

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

## Dependency updates

Every Dependabot ecosystem waits 7 days after a release for routine version updates.
The cooldown does not delay security updates.

Dependabot ignores semver-major updates for npm, Docker and Cargo.
Cargo pins direct crates with `=` and uses `versioning-strategy: lockfile-only`, so Dependabot cannot change a pinned major version.
Bump a major version in a ticketed PR that updates the manifest pin, `Cargo.lock` and any code the new API needs.

<a id="settings-for-chad"></a>

## Applied main-branch ruleset

Chad applied Phase 1 on 2026-10-17. The GitHub ruleset
[main CI controls](https://github.com/poitee/PrintPartner/rules/25285698), ID `25285698`,
is active on the default branch, currently `main`.
The [committed ruleset JSON](main-ci-controls.ruleset.json) records the live configuration read on 2026-10-18.
It omits node IDs, timestamps, API links, and the current user's bypass capability.

The applied ruleset has these protections:

- Block branch deletion and force pushes.
- Require a pull request and allow only squash merges.
- Require GitHub Actions checks `actionlint`, `zizmor`, `rust (linux)`, and `rust (windows)`.
- Allow branches that are not up to date with `main`.
- Keep the bypass list empty, with no standing admin or bot bypass.

The live ruleset requires four checks. `rust (macos)` is absent, consistent with its advisory status in [Continuous integration](ci.md).
The Phase 1 ticket report lists five required checks. Chad must reconcile that discrepancy.
This snapshot records the applied configuration without changing settings.

No approving reviews are required yet. Code-owner review, dismissal of stale approvals,
approval of the latest push, and review-thread resolution are disabled.
All agent lanes currently author PRs as `poitee`, and GitHub forbids self-approval.
CODEOWNERS requests Chad's review but does not yet make that review a merge requirement.

To compare the snapshot with the live ruleset, run this read-only check from the repository root:

```sh
gh api repos/poitee/PrintPartner/rulesets/25285698 \
  | jq -S 'del(.node_id, .created_at, .updated_at, ._links, .current_user_can_bypass)' \
  | diff -u docs/development/main-ci-controls.ruleset.json -
```

No diff means the normalized live response matches the snapshot. A diff needs review before updating the snapshot.

## Phase 2 for Chad

Phase 2 remains Chad's work and keeps GRE-635 open:

1. Create and install a GitHub App for agents with contents, pull requests, and workflows write access, plus checks read access.
   Store its key in the VMs' secret store and switch agent PR authorship to the App.
   Chad owns credentials and their handling.
2. Require code-owner review, dismiss stale approvals, require approval of the latest push, and require review threads to be resolved.
   First test whether code-owner review is enforced with `required_approving_review_count: 0`.
   If it is, only CODEOWNERS paths need Chad's approval. Otherwise, a count of one requires Chad to approve every PR.
3. Test enforcement with the separate agent identity.
   A workflow PR must not merge without Chad's approval.
   A PR touching only `rust/` must merge on green checks if the review policy permits it.
   A docs-only PR must receive both named lint checks.

## Emergency path

Chad can temporarily disable **main CI controls** in **Settings > Rules**.
GitHub logs the change. Re-enable the ruleset after the emergency.
There is no standing admin bypass.
