# GRE-749 concurrency investigation

Status is unresolved. The diagnostic script reproduces existing bugs. It does
not implement prevention, and no production code or workflow has changed.

## Evidence

The checkout matches `origin/main` at `8511ab55`. The open-PR check found no
overlapping Linear sync change on 2026-10-18.

Run the diagnostics and existing tests locally:

```sh
python3 -B scripts/linear/reproduce_concurrent_writes.py -v
python3 -B -m unittest discover -s scripts/linear -p 'test_*.py' -v
```

All four diagnostics reproduce their asserted outcomes. All 28 existing tests
pass. Diagnostic success means the unsafe outcome occurred, not that it was
prevented. The diagnostics stay outside ordinary `test_*.py` discovery so that
future regression tests do not require preserving these bugs.

Each diagnostic loads separate copies of the production module, with independent
PR and state caches, against one fake Linear store. A callback pauses one API
operation before the fake server accepts it. The other runner completes before
the first resumes. Network requests and subprocess calls raise an assertion.

The controlled outcomes are:

- A shared-issue open event pauses at `issueUpdate`. Another PR's Fixes merge
  writes Done. The open event resumes and overwrites Done with In Review.
- A reconcile stall sweep pauses at `issueUpdate`. An open event writes
  In Review. Reconciliation resumes and overwrites it with Backlog.
- An event pauses at `commentCreate` after finding no matching comment.
  Reconciliation processes the same PR and creates the comment. The event
  resumes and creates an identical second comment.
- An unrelated issue's event completes while the first issue's update is
  paused. Both issues finish In Review. Serialization must retain this
  independence.

`move()` checks the state from an earlier issue read, then sends an unconditional
`issueUpdate`. Its comment lookup and creation are separate operations too.
Refreshing the issue immediately before the mutation still leaves a gap between
that read and the write.

The [published Linear schema](https://github.com/linear/linear/blob/9dd2ed80f93ae596f4f7fa21aa7cf80895c58514/packages/sdk/src/schema.graphql)
defines `issueUpdate(id, input)` and `IssueUpdateInput` without an expected-state,
version, or expected-`updatedAt` condition. This finding concerns the published
interface, not undocumented server capabilities. No live mutation was probed.

## Candidate mechanisms

A per-issue Actions job can serialize event and reconcile writers without new
GitHub permissions. Preparation discovers identifiers only, including edited
events' previous references. Each worker acquires its issue's concurrency group
before reading GitHub PRs, the Linear issue, or comments, and writes only that
issue. Reconciliation's stall sweep must use those same groups.

Under [GitHub's default concurrency policy](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency),
a new pending job replaces the previous pending job, even with
`cancel-in-progress: false`. A correct worker cannot therefore depend solely on
its triggering event. It must recover merged Fixes, slice comments, and removals
whose jobs were replaced.

Current PR snapshots recover merged Fixes and merged slice references. They do
not retain a removed reference's old body or title. Consider a running GRE-1
worker, a pending removal event for GRE-1, and then a reconcile worker that
replaces the removal job. The surviving worker cannot recover that removal's
provenance from current PR snapshots.

Two designs need different commitments:

- An aggregate worker can move In Review issues with no current open PR to
  In Progress, using a generic explanation when removal provenance is missing.
  This changes behavior for manually placed In Review issues without PRs.
- Preserving event-specific behavior requires retaining removed-reference
  deltas before pending work can be replaced, or verifying an adequate historical
  source. A new storage service or write permission must be explicitly approved
  if the selected design needs it.

GitHub also documents `queue: max`, which retains up to 100 pending jobs per
group. A local syntax-only fixture with this property fails the repository's
pinned actionlint 1.7.12 with `unexpected key "queue" for "concurrency" section`.
Using this alternative needs a compatible lint path and explicit queue-overflow
handling. The fixture was never submitted to GitHub Actions.

A complete design must also handle the 256-job matrix limit without silent
truncation. Workers must execute compatible trusted code. Already-created old
runs will not acquire a newly introduced lock. A rollout that guarantees no
overlap with old writers needs an operator-controlled drain. This investigation
did not cancel or rerun any workflow.

A single global concurrency group remains excluded by the ticket. A local
process lock cannot coordinate the hosted runners. Linear comments used as
leases would need unverified write semantics and cannot fence delayed
`issueUpdate` requests. None of these alternatives was applied.

## Escalation and next slice

Decide whether an aggregate orphaned-In-Review rule is acceptable, or whether
removed-reference deltas and their event-specific behavior must be retained.
Then implement the per-issue writer with bounded fanout, queue handling, and a
rollout plan. Reuse these interleavings as regression tests that assert Done and
In Review are preserved and exactly one comment is created.

This decision is separate from the existing rapid same-PR edit limitation.
Per-issue pending-job replacement introduces a loss path across different PR
events and reconciliation, so it cannot be dismissed as that existing limit.

Prepared ticket comment, not posted because real Linear writes are prohibited:

> ESCALATE GRE-749. Fake API interleavings reproduce stale Done and In Review
> overwrites and duplicate comments. Per-issue Actions workers can use existing
> permissions, but pending-job replacement can lose removed-reference deltas.
> Choose an aggregate rule for In Review issues with no open PR, or require
> retained removal deltas. `queue: max` is another candidate, but the pinned
> actionlint rejects it and its queue is bounded. No production workflow or
> Linear write was performed.
>
> next slice: resolve the removal and queue policy, then implement and prove
> per-issue event/reconcile writers with bounded fanout and a safe rollout.
