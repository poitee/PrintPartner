# GRE-749 concurrency investigation

Status is unresolved. The diagnostic script reproduces existing bugs. It does
not implement prevention, and no production code or workflow has changed.

## Evidence

Run the diagnostics and existing tests locally:

```sh
python3 -B scripts/linear/reproduce_concurrent_writes.py -v
python3 -B scripts/linear/reproduce_reference_recovery.py -v
python3 -B -m unittest discover -s scripts/linear -p 'test_*.py' -v
```

The four concurrency diagnostics, six recovery diagnostics, and ordinary tests
pass. Diagnostic success confirms the unsafe outcomes and the independence
control, not prevention. The diagnostics stay outside ordinary `test_*.py`
discovery so that future regression tests do not require preserving these bugs.

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

The current workflow uses separate `linear-pr-sync-<PR number>` groups and a
`linear-pr-sync-reconcile` group, with `cancel-in-progress: false`. Shared-issue
PRs and reconciliation can therefore execute these interleavings.

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
issue. Every reconciliation write must use those groups, including both its
PR replay and stall sweep. These groups would serialize this workflow only.
Manual Linear edits and other automations could still race its unconditional
updates.

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

## Historical recovery decision

`reproduce_reference_recovery.py` adds six fake-only diagnostics through production
`apply_event()`, `move()`, and `reconcile()`. It reuses the fake Linear store and
isolated production-module loader from the concurrency diagnostic. Network and
process execution are forbidden. The issue's update is one hour old, below the
48-hour stall threshold, so the stall sweep cannot obscure the removal result.

The controlled outcomes are:

- An OPEN PR with `Refs GRE-1` only in its body creates no comment or state write
  when GRE-1 is already In Review. The title and branch contain no reference.
- Retaining the edited event's previous body moves GRE-1 to In Progress and
  creates exactly `[pr-status-sync] PR #1 removed its reference; no other open PR.`
- Replacing that pending removal with reconciliation leaves GRE-1 In Review
  with no comment or state write. This models the successor running alone,
  rather than executing an Actions scheduler.
- Two modeled histories have the same current PR, empty title-rename history,
  unavailable body-edit content with equal surviving metadata, Linear issue,
  and empty Linear comments. One old body says `Refs GRE-1`. The other has no
  reference. Replaying their retained events proves that only the first needs
  the removal transition and explanation.
- Another current open PR referencing GRE-1 preserves In Review after removal.
  A manually In Review issue with no past reference also stays In Review.

GitHub documents [UserContentEdit](https://docs.github.com/en/graphql/reference/users#usercontentedit)
with deletion metadata and a nullable diff summary.
[RenamedTitleEvent](https://docs.github.com/en/graphql/reference/issues#renamedtitleevent)
records previous and current titles. Body-only edits leave the title unchanged,
so title renames cannot recover the missing body reference in this case.
GitHub also documents that [deleting revision content leaves edit metadata visible](https://docs.github.com/en/communities/moderating-comments-and-conversations/tracking-changes-in-a-comment).

The indistinguishable-history fixture models allowed history deletion. It does
not validate a live GitHub response, parse GitHub diff strings, or prove live
history completeness. Live GraphQL introspection was attempted during this
investigation, but the GraphQL quota was exhausted. No successful live history
inspection supports this decision.

Preserved history and existing sync comments may help recovery. They cannot
guarantee removed-reference provenance when revision content is deleted and
`move()` has omitted an unchanged-state comment. The two histories require
different behavior from identical available evidence. An aggregate rule that
moves every In Review issue without an open PR would violate the manual-state
control and is excluded from this slice.

Escalate durable event retention and any required storage permissions, or a
compatible bounded queue with an explicit overflow policy, before per-issue
rollout. Retention must preserve removal deltas before replaceable processing.

## Queue and rollout constraints

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

## Local retained-event inbox candidate

`scripts/linear/event_inbox.py` is a stdlib-only SQLite candidate for local
experiments. It is not an approved production storage backend or product
decision. No production script imports it, and no workflow uses it.

`EventInbox` stores one immutable byte payload per delivery ID and separate
pending issue destinations. The caller supplies the complete original PR
snapshot and event, including `changes.title.from` and `changes.body.from` when
present, and supplies the discovered issue IDs. The inbox treats payload bytes
as opaque. It does not validate completeness, reconstruct history, discover
references, or invent provenance. Tests encode `{"pr": snapshot, "event": event}`
and pass the decoded values to production `apply_event()` against the existing
fake Linear store. Retained body removal produces the exact removal comment and
In Progress. Another open PR and manual In Review without past provenance both
preserve In Review. A failed fake update leaves the delivery pending for retry.

All four bounds are required positive integers. They limit unique issue fanout
per event, pending deliveries per issue, global pending deliveries, and payload
bytes per event. Every connection verifies the same persisted bounds, even after
the queue empties. Event IDs contain 1 to 128 ASCII letters, digits, dots,
underscores, colons, or hyphens. Issue IDs contain 1 to 64 ASCII letters, digits,
underscores, or hyphens. Both start with a letter or digit. These opaque token
formats accept ticket identifiers and UUIDs without duplicating reference
parsing. The token sizes and fanout bound also constrain retained metadata.
Logical retained rows and bytes are bounded. SQLite file overhead and allocated
pages are not a strict disk quota, and deletion does not promise file shrinkage.

`enqueue(delivery_id, payload, issue_ids)` accepts all destinations atomically or
raises `CapacityExceeded` without evicting accepted events. An identical replay
returns false and does not restore acknowledged destinations. Different bytes or
a different destination set for a retained ID raise `DeliveryConflict`. Target
order and duplicate destinations do not change that set. Empty targets and
invalid IDs are rejected. Payloads must be immutable `bytes`.

`pending(issue_id)` returns non-destructive `(delivery_id, payload)` pairs in
acceptance order. Callers apply them in order, then call
`acknowledge(issue_id, delivery_id)` only after successful application. This
deletes only the specified pending pair. Other issues can progress while that
issue remains unacknowledged. The final destination acknowledgement deletes the
event and its payload. Deduplication lasts only while an event remains retained.
A replay after final deletion can be accepted anew. There is no permanent
acknowledgement ledger, lease, claim, automatic reclaim, or worker orchestration.

`BEGIN IMMEDIATE` serializes capacity checks and writes across connections to one
local SQLite file. Each instance owns one connection for one thread. Reads do
not reserve work, and the inbox does not serialize external application. Local
transaction serialization is not hosted runner coordination or proof of exactly
once Linear writes. A crash after application but before acknowledgement can
replay the external write.

Any future durable ingestion must retain the complete event **before**
replaceable Actions pending processing. An inbox on an ephemeral runner cannot
recover `changes.from` that Actions already dropped. Overflow rejects ingestion.
Upstream must retain the rejected input and retry or escalate, rather than
acknowledge success. Choosing a durable backend, permissions, failure handling,
and rollout remains separate work. This candidate makes no production
prevention claim and authorizes no writer rollout or drain.

## Next slice

Resolve durable event retention and its permissions, or queue compatibility and
overflow behavior. Then prove per-issue event and reconcile writers with bounded
matrix fanout and an operator-controlled drain of old writers before rollout.
Convert the concurrency diagnostics into regression tests that preserve Done
and In Review and create exactly one comment. Preserve the removal explanation
and both negative controls from the recovery diagnostic. This slice implements
no production prevention or rollout, and requests no aggregate behavior change.

This decision is separate from the existing rapid same-PR edit limitation.
Per-issue pending-job replacement introduces a loss path across different PR
events and reconciliation, so it cannot be dismissed as that existing limit.
