# Sync claim and recovery behavior

This module requires the default-off `desktop_rebuild` feature.

A Local target claim checks both the live Source reservation and retained
`claimed` targets for the same tenant and Source. Either conflict returns the
typed `catalog::SourceBusy` error before changing the target or issuing a token.
The original batch can reset its retained claim when its recovered attempt opens.
The competing batch can then retry. Existing Job resource admission still applies,
including its reservations for Jobs that require reconciliation.

Recovery that exhausts 100 attempts closes an open Sync batch through `halt_job`.
Pending targets become `not_run`. Claimed targets become
`reconciliation_required` and retain their claim evidence. With unresolved targets
or generic effects, the Job and batch require reconciliation. Otherwise, the Job
fails and the batch halts with the existing `fatal` code. Recovery also uses this
batch closure for cancellation and retained generic effects from older Jobs.
`halt_job` fences the attempt and saves it once. Reopening storage preserves the
closed batch. Unrelated queued work remains eligible for admission.

## Bind a claimed target

`ServerWorkerClient::bind_source_sync_target` checks a claimed Local target
against its stored claim before the worker trusts it. It returns a
`BoundSyncTarget` with the target key, Source ID and claim generation. The
binding requires all of these conditions:

- The attempt is live and its Job is Sync and not cancelled.
- The batch is open and its sealed basis still matches the payload, target
  count and basis digest.
- The target ordinal is in the basis, the target is `claimed` at the held claim
  generation, and the claim records this attempt's generation, worker and fence.
- The held reservation token and writer incarnation are the ones recorded on the
  target, and the token is still live for the target's Source.

Binding writes nothing, so a refusal leaves every row and the Source row
unchanged. After the claim checks, `validate_target` and
`validate_target_in_basis` compare the bound candidate with the recorded basis:

- The live Source configuration version must equal the version stored at claim.
- The live authority and path observation must equal the stored digests.
- The live activation digest must equal the stored digest. That digest is the
  revision identity, and it also covers Source kind and type.
- A result is optional. When present, its canonical JSON, digest and receipt
  must name this basis Source. Nothing is settled or published.

## Settle one successful target

`ServerWorkerClient::settle_source_sync_target` stores one claimed target's
successful result and releases that target's Source reservation. The batch
stays open. The Job document, the Source row and every other target stay as
they were.

The command refuses, without writing, when the attempt is stale or the held
Source proof is not the live reservation recorded on the target. A result that
names no Source is also refused, and the reservation stays held. The stored
result is the canonical scan JSON, its digest and the Local receipt.
`reservation_acknowledged` becomes 1. The recorded token text stays on the
row; the live token is retired after the commit.

`sync_settle_persists_one_result` settles the first of two targets and checks
that result, the untouched sibling and which reservation was released.
`sync_stale_settlement_preserves_target` checks the exact refusal and an
unchanged database for a stale attempt, a foreign Source proof and a result
that names no Source.

## Run the regression tests

From `rust/`, use the per-VM Cargo wrapper on `PATH`:

```sh
CARGO_BUILD_JOBS=3 RUSTC_WRAPPER=sccache \
CARGO_TARGET_DIR=/persist/targets/gre-775-sync-settle-success \
cargo test -p pp-storage --features desktop_rebuild --lib source_sync::tests -- --test-threads=8
cargo test -p pp-storage --features desktop_rebuild --lib sync_settle_persists_one_result -- --test-threads=8
cargo test -p pp-storage --features desktop_rebuild --lib sync_stale_settlement_preserves_target -- --test-threads=8
```

Feature-off, the settle command and its tables are absent:

```sh
CARGO_BUILD_JOBS=3 RUSTC_WRAPPER=sccache \
CARGO_TARGET_DIR=/persist/targets/gre-775-sync-settle-success \
cargo test -p pp-storage --lib sync_settle_is_absent_without_desktop_rebuild
```

`durable_claim_returns_source_busy_after_restart` and
`durable_claim_returns_source_busy_after_lease_expiry` exercise two Jobs sharing
one Source. Their worker admits two Jobs per resource so the tests reach target
claim admission. They assert the typed error, an unchanged database and lease
version, and successful retry after the original batch releases its durable claim.

The four `*_recovery_closes_sync_batch` tests cover attempt exhaustion,
cancellation, and confirmed or unconfirmed generic effects. Each runs recovery
through restart and lease expiry, with and without a claimed target. They assert
the Job state, target states, batch phase, one generation bump, retained effects,
reopen stability, and admission of later work on an unrelated Source. Fixtures use
temporary directories and fake accounts and Sources.

`sync_candidate_requires_claim_and_current_source_proof` and
`sync_candidate_rejects_changed_basis` cover binding. They tamper with the held
lease, the stored token and the sealed basis, and assert the exact refusal and an
unchanged database for each case. Once the changes are restored, the same target
binds again.

`sync_candidate_content_requires_matching_revision` and
`sync_candidate_rejects_changed_configuration_or_observation` cover content.
They change the live revision, a recorded result, the configuration version and
the local path. Each refusal is the exact error, and the
Sync rows and Source row stay as they were. Restoring the change lets the same
target bind again. A result that names another Source is refused and left in
place. No target becomes succeeded.

Check the package in both feature modes:

```sh
CARGO_BUILD_JOBS=3 RUSTC_WRAPPER=sccache cargo check --locked -p pp-storage --no-default-features
CARGO_BUILD_JOBS=3 RUSTC_WRAPPER=sccache cargo check --locked -p pp-storage --features desktop_rebuild
CARGO_BUILD_JOBS=3 RUSTC_WRAPPER=sccache cargo clippy --locked -p pp-storage --all-targets --no-default-features -- -D warnings
CARGO_BUILD_JOBS=3 RUSTC_WRAPPER=sccache cargo clippy --locked -p pp-storage --all-targets --features desktop_rebuild -- -D warnings
```

Run `cargo test --locked -p pp-storage --test durable_jobs ticket_t_28_recovery`
with the same build settings in each feature mode to check the shared Job recovery
path. Add `--features desktop_rebuild` for the feature-on run.
