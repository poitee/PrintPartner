# D9 coverage audit

GRE-602 covers the manifest text carrier and the ordinary build graph operations.
The reference is `desktop/source-sync-local-current-20261008` at
`d73b6d8d250b84e22b37262a0c2720d4f777a0ca`. The main baseline for this audit is
`2c3dc25e`, including #417, #434, and #453.

The audit found omitted integration assertions for behavior already present
on main. This slice ports the missing tests. It changes no production code.
All added tests compile only with the default-off `desktop_rebuild` feature.

## Coverage map

Paths below are relative to `rust/crates/pp-storage`.

| Original obligation | Main coverage | Disposition |
| --- | --- | --- |
| `manifest_text::carrier_tests::typed_scalar_part_bytes_and_planning_digest_equal_legacy_value`, carrier bytes | `src/manifest_text/tests.rs`, `typed_scalar_carrier_matches_literal_json_and_known_digest` | Covered by literal JSON and known SHA-256 values for all six original text cases. |
| Same original test, required-unit planning integration | Original call is into `required_units::model::planning` | Owned by GRE-606 D11. D9 covers the carrier bytes and exact-byte digest, not the absent planner. |
| `typed_both_metadata_fields_write_distinct_lowercase_units` | Same test name in `src/manifest_text/tests.rs`; `draft_sql_metadata_bindings_survive_real_sqlite` | Covered, including distinct lone surrogates and real SQLite bindings. |
| JSON escaping, ECMAScript trim, array indices, UTF-16 ordering, exact-byte hashing | `src/manifest_text/tests.rs`, `json_*`, `ecmascript_whitespace_set_and_trim_are_exact`, `array_index_boundaries_match_ecmascript`, `ordering_uses_utf16_rather_than_utf8_or_scalar_values`, `digest_hashes_exact_bytes_without_json_normalization` | Covered beyond the two original carrier tests. |
| Canonical SQLite TEXT versus PPJS BLOB, malformed input and budgets | `src/manifest_text/tests.rs`, `sqlite_*`, `draft_sql_*` | Covered, including real SQLite storage classes and invalid UTF-8. |
| Draft aliases, projections, field comparison, metadata separation | `src/manifest_text/tests.rs`, `draft_aliases_projection_and_scalar_mutation_preserve_metadata`, `draft_rejects_manifest_metadata_in_scalar_carrier` | Covered. |
| `authenticated_graph_is_tenant_scoped_atomic_and_path_scoped`, tenant and membership refusal | `tests/build_graph_operations.rs`, `tenant_isolation_missing_and_invalid_credentials`, `mutation_duplicate_missing_membership_and_tenant_cases`, `mutation_requires_valid_credentials_before_writing` | Covered through the public client. |
| Same original test, atomic create and attachment persistence | `mutation_create_touch_attachments_and_delete`, `mutation_create_and_delete_rollback_include_dependent_writes`, new `audit_created_build_and_attachments_survive_owner_reopen` | Mutations and rollback covered. The new reopen test compares committed layers and the build name after owner restart. |
| Same original test, cancellation and stopped owner | `cancelled_and_stopped_requests_are_typed_failures`, `mutation_cancellation_after_transaction_starts_rolls_back_touch` | Covered. |
| `explicit_delete_cleans_settings_layers_and_survives_reopen` | `mutation_delete_cascades_accepted_graph_and_scoped_settings` plus both new `audit_delete_*` tests | Scoped settings, sources, cascades, foreign keys, and missing build after reopen covered. |
| `explicit_delete_cascades_the_public_accepted_plate_history_graph` | New `audit_delete_cascades_public_accepted_plate_graph_across_reopen` | Ported. Uses the original public accepted-plate fixture, checks every original cascade table, retained sources, and two owner reopen cycles. |
| `explicit_delete_cascades_completed_and_sent_jobs_and_preserves_controls` | New `audit_delete_cascades_terminal_jobs_and_preserves_controls_across_reopen` | Ported for both statuses. Also checks same-tenant and foreign-tenant control jobs, control builds, retained sources, and foreign keys across two reopen cycles. |
| List, read, layers and summary projection | `accepted_summary_counts_units_and_preserves_freshness`, `list_and_layers_have_stable_order_and_trim_requests`, `unavailable_states_are_honest`, `review_*`, `ppjs_metadata_is_lossless_and_projection_mismatch_is_integrity` | Covered. Summary facts use the existing read model and `src/build_graph/projection.rs`. |
| Create, touch, set base, attach, replace, detach, delete | `mutation_*` in `tests/build_graph_operations.rs` | All ordinary original commands covered, including duplicate and missing outcomes, tenant isolation, rollback, name parsing, graph limits, and cancellation. |
| Queue admission, deadlines and lost replies | `src/build_graph.rs` unit tests `expired_mutations_skip_sql_and_preserve_timeout_before_fresh_mutation`, `expired_writer_deadline_does_not_block_deferred_reads`, `lost_reply_is_outcome_unknown` | Covered with current-main writer admission. |
| `manifest_reply_loss_is_outcome_unknown`, `uncertain_manifest_save_is_recovered_by_reopen_without_retry` | Original tests exercise `BuildCommand::Manifest` | GRE-604 D10b. Observation, preparation, save recovery, and manifest command dispatch stay blocked on GRE-607 and are not part of D9 completion. |

The production differences from the reference are intentional. The carrier API is
public behind the feature, invalid UTF-8 comparisons return errors, and PPJS writes
enforce the read budget. Build graph summaries reuse main's read model, with typed
limits and integrity outcomes. Mutations use main's writer deadline admission and
also remove Plan feature settings on deletion. Manifest commands and their
observation-specific `ConcurrentUpdate` outcome belong to D10b.

## Evidence

Run the existing suites in both feature configurations:

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild
```

Run the newly ported integration tests:

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --test build_graph_operations audit_
```

All three tests pass against the unchanged main implementation. No pre-existing
behavior failure is claimed. For a negative control, temporarily constrain the
`DELETE FROM build_profiles` statement to exclude builds with rows in
`print_jobs` or `accepted_plate_revisions`. Both deletion tests must fail, then pass after restoring
the original statement. This verifies that the added tests detect a deletion
regression rather than merely exercising fixture setup.
