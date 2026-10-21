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

## Run the regression tests

From `rust/`, use the per-VM Cargo wrapper on `PATH`:

```sh
CARGO_BUILD_JOBS=3 RUSTC_WRAPPER=sccache \
CARGO_TARGET_DIR=/persist/home/build/gre856-target \
cargo test -p pp-storage --features desktop_rebuild --lib source_sync::tests --no-fail-fast
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
