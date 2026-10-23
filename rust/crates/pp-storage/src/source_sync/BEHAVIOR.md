# Sync claim and recovery behavior

This module requires the default-off `desktop_rebuild` feature.

A Local target claim checks both the live Source reservation and any retained
hold on that tenant and Source. A hold is a `claimed` target, or a `succeeded`
or `failed` target whose reservation is not acknowledged. Any conflict returns
the typed `catalog::SourceBusy` error before changing the target or issuing a
token.
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

### Oversized Sync recovery quarantine

`recover_in` quarantines a Sync Job when durable document handling returns
`JobDocTooLarge`—either while decoding a stored row past the size limit, or when
`recover_attempt` / `halt_job` cannot save a recovered document. Quarantine runs
in the same writer transaction: the original document bytes and resource column
stay as stored, history records `document_quarantined_resource_uncertain` when a
resource was held, and operator inspection is required before another Job can
take those Sources. Startup `recover(all=true)` and runtime
`claim()`→`recover_in(tx,false)` share this path. Decode runs before the lease
check, so an oversized running row is quarantined on the next claim even when its
lease is still live. Unrelated Sources stay admissible.

`halt_job` writes batch and target rows before it saves the Job document. When
that save is the `JobDocTooLarge` failure, those batch and target writes remain
with the quarantine commit. No second cleanup path rolls them back; a savepoint
or preflight is not required for this contract. Under current payload and effect
bounds, a terminal Sync halt that replaces a large recovery field typically
shrinks the document, so the halt-then-quarantine interleaving is defensive.

`oversized_sync_recovery_quarantines_on_startup_and_lease_expiry` stores a
running Sync Job one byte over the document limit. Live-lease cells recover
through storage reopen (`recover(all=true)`). Expired-lease cells pad on the live
owner and claim (`recover_in(false)`); they do not reopen. Both claimed and
unclaimed targets are covered. The test asserts quarantine, exact document
retention, unchanged batch/target evidence on the decode path, blocked admission
of overlapping Sources, the uncertain resource, and later work on another Source.
`halt_job_doc_too_large_quarantines_with_batch_and_targets` keeps the document
just under the limit with confirmed effects (a field `halt_job` does not rewrite),
pads on the live owner, claims so `recover_in(false)` hits halt-then-quarantine,
and asserts the Job is quarantined with the original running document while the
batch is `reconciliation_required` and targets show the halt writes
(`reconciliation_required` / `not_run`).

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

## Fail one claimed target

`ServerWorkerClient::fail_source_sync_target` records a local read failure for
one claimed target. `mark_local_failure` writes `sync_error` and
`sync_required` and keeps earlier Source metadata. The target stores
`failure_code` `local_read` and the detail. Claim evidence stays, and
`reservation_acknowledged` stays 0, so the reservation remains held. Progress
counts only acknowledged successes and failures. The batch stays open and the
live token is not retired.

A refusal writes nothing. Empty or over-long detail, a changed Source
observation, and a target that already stores a successful result are refused.
Another target's stored result stays in place.

The next claim returns `RetainedFailure` for that unacknowledged row. The same
row blocks another Job from claiming that Source after storage is reopened. A
completed failure already has its reservation acknowledged, as a missing or
non-Local Source does, and the next claim skips it.

`sync_target_failure_records_source_observation` checks the observation,
unchanged claim capture, progress 0 and the retained next claim.
`sync_failure_does_not_replace_settled_result` keeps a settled result, refuses
a sibling that already stores one, then fails that sibling. Progress becomes
50 because only the acknowledged success counts.

## Acknowledge one retained failure

`ServerWorkerClient::acknowledge_source_sync_target` acknowledges one retained
`local_read` failure when the worker presents the observation stored at claim
and the current attempt still owns that target. The failure code, detail and
result columns stay as recorded. Progress then counts the failure. The batch
stays open. The live Source token is retired after the commit.

A different observation, a stale attempt, or a reservation that is not the one
stored on the target is refused and writes nothing. The failure stays retained,
so the next claim still returns `RetainedFailure` and the Source stays busy.
Moving the Source path after the failure does not change the stored
observation. Acknowledgement still requires the claim observation.

An exact replay presents that same observation again. It returns the same
failure, progress and version, and it writes nothing. A settled sibling's
result stays in place. After acknowledgement the next claim skips the failure,
and another worker can take the Source.

`sync_acknowledgement_requires_matching_observation` checks those refusals and
the acknowledgement that follows. `sync_acknowledgement_replay_preserves_result`
checks the replay, the untouched sibling result and the released Source.

## Adopt one acknowledged success

`ServerWorkerClient::adopt_source_sync_target` returns one already-acknowledged
successful Sync target result when this attempt still owns the claim and the
live Source observation matches the capture stored at claim. The stored result,
receipt and acknowledgement stay as recorded. The command writes nothing.

A changed Source observation is refused as mismatched provenance, without
writing. A stale attempt fence is refused the same way. After the observation
is restored, the same key adopts the retained result again. A reclaimed attempt
after lease expiry is refused as `Sync target attempt mismatch` because the
target still records the claim attempt's generation, worker and fence. A
retained failure is refused as `Sync target is not an acknowledged success`.

`sync_adopts_matching_retained_result` settles one target, adopts that key, and
checks an exact replay with an unchanged database. `sync_adopt_rejects_changed_provenance`
moves the Source path, asserts the refusal and unchanged Sync rows, restores the
path, and adopts successfully. `sync_adopt_rejects_reclaimed_attempt` expires
the lease, reclaims the Job, and asserts the attempt-fence refusal.
`sync_adopt_rejects_failed_target` fails a claimed target and asserts the
acknowledged-success guard.

## Halt after a Source operation error

`ServerWorkerClient::halt_source_sync` connects a caller Source operation error
to the existing batch halt semantics. `SourceSyncHalt::Fatal` stores `fatal`.
`SourceSyncHalt::UncertainTarget` stores `uncertain_target`. The detail becomes
the Job recovery message. Pending targets become `not_run` with `batch_halt`.
A claimed target becomes `reconciliation_required` and keeps its claim evidence.
An unacknowledged retained failure stays as recorded and is not overwritten.

A stale attempt fence is refused without writing. Reopening storage keeps the
recovery message and retained target evidence.

`sync_halt_after_error_retains_primary_failure` fails one target, refuses a stale
halt, then halts with the live lease and checks that the recovery detail and
`local_read` evidence stay after reload. `sync_halt_after_error_keeps_target_for_reconciliation`
halts while a target is still claimed and checks that claim capture remains on
the reconciliation-required row.

## Inspect a live Sync target

`ServerWorkerClient::inspect_source_sync_target` reads one target for the live
authorized attempt. Claimed and pending targets return `Pending`. An
acknowledged success returns its stored result. An acknowledged failure returns
that failure. `not_run` returns `Halted`. Unacknowledged terminal rows and
`reconciliation_required` return `ReconciliationRequired`. The command writes
nothing and does not change reservation ownership.

The Job must still own the attempt, the original authority must still resolve,
and the target row's tenant must match the Job. A foreign Job id, an ordinal
outside the sealed basis, or a tampered tenant is refused without writing.

`sync_inspect_returns_authorized_target` claims, inspects `Pending`, settles,
then inspects the exact settled result twice with an unchanged database.
`sync_inspect_is_read_only_and_tenant_scoped` checks those refusals and that
successful inspection leaves every Sync row unchanged.

## Run the regression tests

From `rust/`, use the per-VM Cargo wrapper on `PATH`:

```sh
CARGO_BUILD_JOBS=3 RUSTC_WRAPPER=sccache \
CARGO_TARGET_DIR=/persist/targets/gre-775-sync-settle-success \
cargo test -p pp-storage --features desktop_rebuild --lib source_sync::tests -- --test-threads=8
cargo test -p pp-storage --features desktop_rebuild --lib sync_settle_persists_one_result -- --test-threads=8
cargo test -p pp-storage --features desktop_rebuild --lib sync_stale_settlement_preserves_target -- --test-threads=8
CARGO_BUILD_JOBS=3 RUSTC_WRAPPER=sccache \
CARGO_TARGET_DIR=/persist/targets/gre-776-failed-sync-target \
cargo test -p pp-storage --features desktop_rebuild --lib -- --test-threads=8 \
  sync_target_failure_records_source_observation \
  sync_failure_does_not_replace_settled_result \
  unacknowledged_failure_blocks_claim_after_restart
```

Feature-off, settle, fail, acknowledge, adopt, halt, inspect and their tables are absent. The same check covers those commands:

```sh
CARGO_BUILD_JOBS=3 RUSTC_WRAPPER=sccache \
CARGO_TARGET_DIR=/persist/targets/gre-776-failed-sync-target \
cargo test -p pp-storage --lib sync_settle_is_absent_without_desktop_rebuild
```

Acknowledge a retained failure with:

```sh
CARGO_BUILD_JOBS=3 RUSTC_WRAPPER=sccache \
CARGO_TARGET_DIR=/persist/targets/gre-777-ack-retained-evidence \
cargo test -p pp-storage --features desktop_rebuild --lib -- --test-threads=8 \
  sync_acknowledgement_requires_matching_observation \
  sync_acknowledgement_replay_preserves_result
```

Adopt an acknowledged success with:

```sh
CARGO_BUILD_JOBS=2 \
CARGO_TARGET_DIR=/persist/targets/gre-778-sync-adopt \
cargo test -p pp-storage --features desktop_rebuild --lib -- --test-threads=2 \
  sync_adopts_matching_retained_result \
  sync_adopt_rejects_changed_provenance \
  sync_adopt_rejects_reclaimed_attempt \
  sync_adopt_rejects_failed_target
```

Halt after a caller Source operation error with:

```sh
CARGO_BUILD_JOBS=2 \
CARGO_TARGET_DIR=/persist/targets/gre-779-sync-halt \
cargo test -p pp-storage --features desktop_rebuild --lib -- --test-threads=2 \
  sync_halt_after_error_retains_primary_failure \
  sync_halt_after_error_keeps_target_for_reconciliation
```

Inspect a live Sync target with:

```sh
CARGO_BUILD_JOBS=2 \
CARGO_TARGET_DIR=/persist/targets/gre-780-sync-inspect \
cargo test -p pp-storage --features desktop_rebuild --lib -- --test-threads=2 \
  sync_inspect_returns_authorized_target \
  sync_inspect_is_read_only_and_tenant_scoped
```

`durable_claim_returns_source_busy_after_restart` and
`durable_claim_returns_source_busy_after_lease_expiry` exercise two Jobs sharing
one Source. Their worker admits two Jobs per resource so the tests reach target
claim admission. They assert the typed error, an unchanged database and lease
version, and successful retry after the original batch releases its durable claim.
`unacknowledged_failure_blocks_claim_after_restart` fails a claimed target, closes
and reopens storage, then refuses the second Job's claim. The failed row stays
as it was.

The four `*_recovery_closes_sync_batch` tests cover attempt exhaustion,
cancellation, and confirmed or unconfirmed generic effects. Each runs recovery
through restart and lease expiry, with and without a claimed target. They assert
the Job state, target states, batch phase, one generation bump, retained effects,
reopen stability, and admission of later work on an unrelated Source. Fixtures use
temporary directories and fake accounts and Sources.

The oversized Sync recovery quarantine tests cover the size-limit contract above.
Check them with:

```sh
CARGO_BUILD_JOBS=2 \
cargo test -p pp-storage --features desktop_rebuild --lib -- --test-threads=2 \
  oversized_sync_recovery_quarantines_on_startup_and_lease_expiry \
  halt_job_doc_too_large_quarantines_with_batch_and_targets
```

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
