# GRE-783: guard Sync prune and reconciliation

This slice needs the default-off `desktop_rebuild` Cargo feature. It does not
cut over production Sync and does not read `PP_DESKTOP_REBUILD`.

## Prune

Job retention runs through `WriterOwner::retain_jobs` and after a writer
transaction that ends a Job. With the feature on, retention skips a terminal
Job while any of its Sync targets is still:

- `pending`, `claimed` or `reconciliation_required`, or
- `succeeded` or `failed` with an unacknowledged reservation.

Deleting the Job row cascades to its batch and target rows, so pruning would
drop that evidence. A `claimed` row, or a `succeeded` or `failed` row with an
unacknowledged reservation, is also the durable claim that blocks another Sync
Job from claiming the same Source. `pending` and `reconciliation_required` rows
do not block a claim. They are kept because the batch has not settled them. A
skipped Job keeps its batch, target, document, history and key rows as they
were. Retention still prunes and counts other Jobs.

Retention can prune a Sync Job whose targets are all settled and acknowledged.
The archived document in `durable_job_keys` keeps the finish result: the
terminal state, the version and the `public_result` aggregate. An Enqueue
replay with the original key returns that archived Job.

## Reconciliation

Generic `UserOperation::Reconcile` refuses a Sync Job with
`Sync cannot use generic effect reconciliation`. This check runs before the
version, generation and effect checks. It writes nothing, not even a
`durable_job_reconciliations` row. The retained evidence stays in the Sync
batch, and `inspect_source_sync_recovery` reports it.

With the feature off, neither guard compiles. Retention uses the original
query, the Sync tables do not exist, and generic reconciliation of a Sync Job
works as before.
`integration_wildcard_uncertainty_and_abandon_guard_until_matching_resolution`
covers that path.

## Tests

`sync_prune_refuses_retained_claim` runs three held shapes: a claimed target,
an unacknowledged `local_read` failure, and a halted claim left in
`reconciliation_required`. The test forces each held Job terminal and ages it
past the 24 hour window, next to an aged finished Job. `retain_jobs(1, 1)`
returns 1, the held rows are unchanged, and the finished Job's archived
document keeps the aggregate. A second call returns 0 and changes nothing.

`sync_reconciliation_uses_batch_owner` recovers a Sync Job with a claimed
target and an unconfirmed generic effect. Every Reconcile decision fails with
the exact error and leaves the database unchanged. The recovery inspection then
reports the `reconciliation_required` and `not_run` targets.

```sh
cd rust
CARGO_BUILD_JOBS=4 RUSTC_WRAPPER=sccache \
CARGO_TARGET_DIR=/persist/targets/gre-783-sync-prune \
cargo test --locked -p pp-storage --features desktop_rebuild --lib -- --test-threads=4 \
  sync_prune_refuses_retained_claim \
  sync_reconciliation_uses_batch_owner
```
