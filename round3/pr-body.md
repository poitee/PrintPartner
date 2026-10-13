Current head `8f06f75a9ad2fbc433d3c3244f50b92a2b70871f` adds dedicated real SQLite-full rollback/retry coverage to the reviewed crash-recovery correction. This last addition changes only a test in jobs.rs. The required claims filter now passes 16 tests. Production route/worker cutover remains a GRE-408 acceptance gate.

Current head `b4fb2cabde42738bbce7047bc0e8dce3d1698b20` includes the latest `desktop/domain-family-integration` parent. The lease guard remains private under `lease/guard.rs`; its stale-owner validation is shared with schema preflight. The crash/retry regression passes without deleting the owner marker.

GRE-408 crash/retry correction at `d24091264eee977610588e375ff89bc31fa5440b`. A dead writer left an owner marker that schema preflight rejected before stale-owner takeover could run. Preflight now shares the lease validation predicate and admits only a provably stale owner. Lease takeover stays under the lock. The regression restarts with the original owner marker intact and proves retry and stale-update fencing.

When reconciliation confirms an upload and print start was not admitted or is confirmed to have had no effect, the job finishes uploaded-only and releases the printer. A later start requires a separate deliberate PrinterStart job bound to that retained upload. Unknown admitted starts are never retried automatically.

This update keeps the current Auth and catalog parent, validates retained printer child identity during replay, and installs transactionally maintained indexes for live and archived parent bindings. Reconciliation uses the proven primary printer receipt even when ancillary Spoolman effects exist. Finish accepts only that exact primary receipt.

These are Linux checks. Application routes, real printer workers, browser controls, native GUI and macOS validation remain separate.

## Evidence

### Final-round SQLite-full coverage, 2026-10-13

Head `8f06f75a9ad2fbc433d3c3244f50b92a2b70871f`. One tests-only file, 93 added lines after b4fb2cab; no production queue logic change. A SQLite page budget forces actual ErrorCode::DiskFull during durable enqueue. The failed transaction leaves jobs, idempotency keys and history at their prior counts, and leaves no failed key. Restoring capacity permits retry of that same key, and replay returns the same id without duplicated rows. [Exact focused test, 1 passed](https://github.com/poitee/PrintPartner/blob/b634cdbbadbb2b19089068889766bed56dea2beb/round3/sqlite-full-exact.log), [required workspace claims filter, 16 passed](https://github.com/poitee/PrintPartner/blob/b634cdbbadbb2b19089068889766bed56dea2beb/round3/claims.log), [scope and reproduction notes](https://github.com/poitee/PrintPartner/blob/b634cdbbadbb2b19089068889766bed56dea2beb/round3/README.md).

Formatting, Clippy and diff checks pass. The integrated production-code receipts below remain 155 storage tests and nine Core marker cases; those broader tests were not rerun for this isolated test addition. This SQLite component test does not claim public WriterOwner disk-quota admission or the CommitUnknown protocol.

Grok Build round 2 passed the scoped restart correction at 9/10 but rated full GRE-408 readiness 6/10. Final round 3 will score this exact head after the disk-full test and evidence corrections. All 28 job aliases remain compat-owned and no production durable job client/worker is wired. GRE-408 stays In Progress while full readiness is unresolved. New-head CI is pending.

The precise Core setup failure wording and the append-only canonical red-log correction are reflected in the current artifact notes and decision trail. No PR merge or force push.

### Parent integration and current-head checks, 2026-10-13

Head `b4fb2cabde42738bbce7047bc0e8dce3d1698b20` normally merges base `c9534f004422c23b7899d2af01a8960843e06681`. The single lease.rs conflict was resolved by retaining the parent's private guard module and the restart fix's shared predicate. No force push, base retarget, duplicate schema, or PR merge.

After integration, **155/155 full serial storage tests**, **15/15 required claims tests**, and **9/9 Core marker cases** pass. The unchanged crash test passes. Formatting, Clippy and boundaries pass. [Full storage log](https://github.com/poitee/PrintPartner/blob/e3b1ba8c1ac19e4fc214e0ba21ed9f2ecddf5df8/round2/storage.log), [claims log](https://github.com/poitee/PrintPartner/blob/e3b1ba8c1ac19e4fc214e0ba21ed9f2ecddf5df8/round2/claims.log), [Core runtime log](https://github.com/poitee/PrintPartner/blob/e3b1ba8c1ac19e4fc214e0ba21ed9f2ecddf5df8/round2/core-markers-refreshed.log), [integration artifact notes](https://github.com/poitee/PrintPartner/blob/e3b1ba8c1ac19e4fc214e0ba21ed9f2ecddf5df8/round2/README.md). The measured release manifest was regenerated at this exact head.

The first Core replay used the stale generated manifest. Four startup cases failed directly with Release artifact content mismatch. Two failed at downstream readiness and concurrent-owner assertions, with an artifact mismatch also logged by the fixture subprocess. After refreshing the manifest, the same nine cases passed. This setup failure is retained in the logs. Source hashes match the committed files. The original genuine red crash test and its green correction remain linked below.

Verifier round 1 was cancelled without a score after the base changed. Its partial CI observation was that d2409126 had only Evidence/parity CI, rather than the broader Rust/runtime suite. Round 2 will inspect this exact integrated head and the actual new-head CI. New-head CI is pending.

Full GRE-408 acceptance gaps remain unchanged, including route/worker cutover and dedicated SQLITE_FULL coverage. These receipts prove the scoped restart correction and integration.

### GRE-408 crash/retry evidence, 2026-10-13

Head `d24091264eee977610588e375ff89bc31fa5440b`. This update is four files, 138 insertions and 19 deletions against prior head `2254b567a48f12f9de8fc4f23321695753ca66cf`. It fixes stale-owner preflight without a new schema, public API or route switch.

The final crash regression failed before the fix with exit 101, 0 passed and 1 failed at `Data directory already owned`. It passed after the fix with exit 0, 1 passed and 0 failed. [Red log](https://github.com/poitee/PrintPartner/blob/d85860ac993200391be7974b7dc47ad82b52505a/crash-red-reproduced.log), [green log](https://github.com/poitee/PrintPartner/blob/d85860ac993200391be7974b7dc47ad82b52505a/crash-green-after-fix.log). An earlier draft that deleted the marker was rejected and is excluded from accepted evidence.

`cargo nextest run --locked --manifest-path rust/Cargo.toml --no-tests=fail -E 'test(ticket_t_28_claims)'` passed **15 tests**. The serial full `pp-storage` run passed **152 tests**, with zero skipped. The nine real Core owner-marker cases passed. Formatting, Clippy with `-D warnings`, boundary self-tests and diff checks passed. [Required filter](https://github.com/poitee/PrintPartner/blob/d85860ac993200391be7974b7dc47ad82b52505a/claims-final.log), [full storage log](https://github.com/poitee/PrintPartner/blob/d85860ac993200391be7974b7dc47ad82b52505a/storage-final.log), [Core marker runtime log](https://github.com/poitee/PrintPartner/blob/d85860ac993200391be7974b7dc47ad82b52505a/live-owner-marker-after-fix.log), [all artifacts and commands](https://github.com/poitee/PrintPartner/blob/d85860ac993200391be7974b7dc47ad82b52505a/README.md).

Runtime evidence uses an actual subprocess exit 28 without destructors. The persisted running job survives, reclaims at attempt 2 and generation 3, preserves duplicate enqueue identity, rejects a second active claim, and rejects stale heartbeat and completion without record or history writes. Successful completion survives another reopen. Source hashes in the artifacts match the committed files. Desktop assets were unchanged and their measured manifest uses baseline commit 2254b567.

**GRE-408 full acceptance remains open.** All 28 jobs route aliases remain compat-owned, there is no production durable worker/client, and dedicated SQLITE_FULL coverage is absent. This correction advances the existing storage foundation and does not establish the complete route/worker cutover or parent acceptance. [Ownership inventory](https://github.com/poitee/PrintPartner/blob/d85860ac993200391be7974b7dc47ad82b52505a/ownership-audit.json), [decision log](https://github.com/poitee/PrintPartner/blob/d85860ac993200391be7974b7dc47ad82b52505a/decisions.tsv).

The prior head had 17 passing checks. Checks for this new head are pending and will be read separately. The main-branch Evidence checker was replayed locally, including all eight checker tests.

Exemption: none

### Historical evidence before the GRE-408 correction

### GRE-354 fallback: prepare #134 against post-#197 main (2026-10-10)

Head: `9b2d8da67113521b9fe1b51e7e55c53b7eca33f2`. [T3 thread](t3-thread://v1/6192c842-e163-465f-a817-3c1c79d13081/mcp%3A2fb9076e-86d6-452d-b3f6-a62ee9ac3da1).

**GRE-354 direct implementation is BLOCKED.** Checked origin/main and the listed Linear blockers: main contains the GRE-338 crate split but no `pp-storage` SQLite writer/schema owner. GRE-339's required owner lives in the unmerged desktop chain (#128); durable Jobs lives in this layer (#134). Main's gateway, compatibility principal machinery and contract fixtures do not supply that transaction owner or Rust Auth storage. GRE-340 backup/schema recovery and GRE-349 Auth ownership likewise require the chain. No replacement blocker implementation or new GRE-354 completion claim is made.

Fallback target discovered with `gh`: #133 head is `desktop/domain-family-integration`; #134 is the open PR based on that branch. Created a fresh tracking branch, merged the base, merged origin/main, and merged later base/main updates using merge commits only. Resolved Cargo.toml/Cargo.lock/boundary-checker conflicts by preserving `pp-api`, `pp-storage`, `pp-source` and adding all five #197 crates. Locked metadata and boundary checks cover all 14 workspace members. Both latest fetched base and main are ancestors of this head. Every new commit is authored and committed as `poitee <915726+poitee@users.noreply.github.com>`. Normal push to `desktop/jobs-domain-integration`; no force push, rebase or PR merge.

Greptile P1s already fixed on the starting head: confirmed print outcome retained after denied Spoolman deduction; complete encoded job size checked before writes; damaged attempts quarantined without consuming worker capacity while uncertain reservations survive. Their existing regressions pass. Fresh initial review state had no unresolved threads; no duplicate fixes added.

Exemption: not user-visible (core internals, no UI)

Model/harness: Codex gpt-6.1-sol (medium) on T3 VM 135

**Verification:** 256 passed, 0 failed, 0 ignored in the complete locked workspace run with `RUST_TEST_THREADS=1`. All 75 durable-job tests pass. Native macOS-only tests are not exercised on this Linux VM. The latest base update affects only a macOS-gated test; formatting and clippy were checked again after integrating it. Built the existing React/Node assets with Node 24.21.0 and generated the measured manifest; no native GUI evidence is claimed for this integration update.

The first exact `cargo test --locked --manifest-path rust/Cargo.toml` run failed at an existing one-second wall-clock assertion in `ticket_t_17_hostile_costs_reject_before_hashing` under parallel load. A focused serial auth suite passed 10/10, then the full locked serial run below passed. The assertion/security limit is unchanged. These receipts do not establish GRE-354 completion; its nextest claims/recovery/streams gates were not run as a new implementation receipt in this fallback.

Fault/recovery checks exercised by the existing tests include:
- `ticket_t_28_claims_duplicate_conflict_and_concurrent_claims`
- `ticket_t_28_claims_duplicate_concurrent_enqueue_and_no_handler_admission`
- `ticket_t_28_claims_cancel_before_admission_running_and_effect`
- `ticket_t_28_claims_expired_lease_fences_old_worker`
- `ticket_t_28_claims_lost_reply_drain_and_backup_committed_job`
- `ticket_t_28_claims_ordinary_transaction_error_rolls_back`
- `ticket_t_28_claims_schema35_migration_rollback_and_backup_restart`
- `ticket_t_28_recovery_lost_claim_reply_is_fenced_on_orderly_restart`
- `ticket_t_28_recovery_receipts_duplicate_effects_and_finish`
- `ticket_t_28_recovery_abandon_keeps_uncertain_proof_and_resource_lock`
- `invalid_attempts_do_not_consume_worker_capacity_but_keep_printer_reservations`
- `denying_spoolman_deduction_preserves_confirmed_print`
- `job_document_over_size_limit_rejects_without_any_writes`

<details><summary>Exact final workspace test output (exit 0)</summary>

Command: `RUST_TEST_THREADS=1 cargo test --locked --manifest-path rust/Cargo.toml`

```text
    Finished `test` profile [unoptimized + debuginfo] target(s) in 1.21s
     Running unittests src/lib.rs (rust/target/debug/deps/pp_api-11f27eccb43d76ea)

running 12 tests
test auth::http::tests::health_keeps_policy_rejections_degraded_and_runtime_failures_fatal ... ok
test auth::mail::tests::smtp_delivers_real_envelope_subject_link_and_reports_uncertain_send ... ok
test auth::mail::tests::smtp_http_failure_keeps_committed_token_without_enumeration_or_retry ... ok
test auth::mail::tests::smtp_rustls_encrypts_data_and_rejects_untrusted_certificate ... ok
test auth::mail::tests::smtp_without_canonical_origin_does_not_mint_or_send_even_in_dev ... ok
test auth::provider::tests::closed_and_single_account_provider_rules_are_transactional ... ok
test auth::provider::tests::discord_form_and_trusted_verified_email_only ... ok
test auth::provider::tests::github_pkce_verified_email_skip_enrichment_and_one_use_state ... ok
test auth::provider::tests::github_unverified_email_is_ignored_and_open_verified_email_links ... ok
test auth::provider::tests::linked_account_sessions_remember_their_sign_in_provider ... ok
test auth::provider::tests::manufactured_expired_cross_browser_cross_provider_states_never_exchange ... ok
test auth::provider::tests::rejected_provider_responses_do_not_mutate_and_state_stays_consumed ... ok

test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 55.95s

     Running unittests src/bin/auth-http-fixture.rs (rust/target/debug/deps/auth_http_fixture-1b648697f80ebb61)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/auth_http.rs (rust/target/debug/deps/auth_http-3ca365bfecdaf3b9)

running 11 tests
test credential_error_codes_and_config_validation ... ok
test guards_missing_routes_and_declared_rate_limits ... ok
test health_propagates_invalid_stored_session_provider ... ok
test imported_multiple_accounts_close_all_session_domain_clients ... ok
test keys_are_flattened_one_time_and_rotate_revoke_persist ... ok
test me_reports_password_presence_independent_of_session_provider ... ok
test oauth_only_reset_preserves_identity_and_ordinary_no_enumeration ... ok
test old_default_keys_expiry_session_expiry_and_storage_errors_are_safe ... ok
test public_cookie_catalog_and_accepted_reads_share_default_tenant ... ok
test registration_race_and_owner_policy_are_transactional ... ok
test stopped_writer_is_service_unavailable ... ok

test result: ok. 11 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 47.26s

     Running unittests src/lib.rs (rust/target/debug/deps/pp_api_types-7fb5cf80d0bc3ca6)

running 9 tests
test autosave::tests::basis_consistency_cannot_relax ... ok
test autosave::tests::codepoint_length_does_not_apply_legacy_utf16_bounds ... ok
test autosave::tests::decision_count_bounds_cannot_relax ... ok
test autosave::tests::duplicate_target_field_rejects_but_distinct_fields_remain_valid ... ok
test autosave::tests::integer_bounds_and_no_coercion_cannot_relax ... ok
test autosave::tests::observed_draft_state_and_base_linkage_cannot_relax ... ok
test autosave::tests::receipt_identity_and_digest_preserve_exact_values ... ok
test autosave::tests::required_nullable_fields_cannot_become_optional ... ok
test autosave::tests::strict_fields_and_discriminator_cannot_relax ... ok

test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.98s

     Running unittests src/lib.rs (rust/target/debug/deps/pp_compat-42bad68b202d6428)

running 8 tests
test release::tests::dependency_aliases_are_measured_and_cannot_escape ... ok
test tests::cancellation_dominates_an_observed_abnormal_exit ... ok
test tests::observed_abnormal_exit_without_cancellation_still_restarts ... ok
test tests::planned_shutdown_accepts_only_observed_success_or_server_sigkill ... ok
test tests::process_stop_continues_cleanup_after_log_join_error ... ok
test tests::product_backoff_schedule ... ok
test tests::startup_sleep_cancellation_classifies_as_planned_shutdown ... ok
test tests::unplanned_observed_exit_preserves_recovery_path ... ok

test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.02s

     Running tests/installed_bundle_lifecycle.rs (rust/target/debug/deps/installed_bundle_lifecycle-20106a5c91e1ac96)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (rust/target/debug/deps/pp_contracts-c8f7ab1e4fbe15da)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/bin/contract-parity.rs (rust/target/debug/deps/contract_parity-916173d1ccee705c)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/consumer.rs (rust/target/debug/deps/consumer-ba3c7a2e22d2a675)

running 3 tests
test external_consumer_reads_typed_request_and_constructs_exact_receipt ... ok
test malformed_scalar_text_rejected_and_valid_pairs_preserved ... ok
test public_construction_and_deserialization_cannot_bypass_invariants ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.55s

     Running unittests src/lib.rs (rust/target/debug/deps/pp_core-d42f21366af775c2)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/runtime_m0.rs (rust/target/debug/deps/runtime_m0-f5bc975dcaf7e42b)

running 23 tests
test authenticated_logout_requests_complete_shutdown ... ok
test changed_or_missing_built_artifacts_are_rejected ... ok
test childless_core_marker_without_known_protocol_refuses_start ... ok
test cleanup_error_publishes_failed_and_preserves_failure ... ok
test compatibility_cleanup_failure_reports_failed_instead_of_ready ... ok
test core_death_with_live_child_refuses_standalone_node ... ok
test core_process_fixture ... ok
test crash_guard_stops_after_five_failures_and_recovers_explicitly ... ok
test crash_left_marker_allows_later_start ... ok
test dead_core_marker_with_partial_or_invalid_child_info_refuses_start ... ok
test dead_core_marker_without_child_info_allows_start ... ok
test desktop_manifest_and_icons_are_served_as_assets ... ok
test desktop_marker_with_both_processes_dead_allows_start ... ok
test drop_after_caller_runtime_teardown_reaps_writer_and_descendant ... ok
test expired_bootstrap_is_denied_by_real_listener ... ok
test failed_bind_releases_owner_before_any_child ... ok
test live_marker_owner_still_blocks_start ... ok
test protected_real_node_lifecycle ... ok
test reused_pid_with_different_identity_recovers_marker_and_lease ... ok
test stable_child_resets_backoff_without_erasing_rapid_crash_escalation ... ok
test stale_owner_recovery_admits_only_one_concurrent_start ... ok
test unexpected_marker_directory_is_preserved_and_reported ... ok
test wrong_release_is_rejected_before_storage_or_child ... ok

test result: ok. 23 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 792.44s

     Running unittests src/lib.rs (rust/target/debug/deps/pp_domain-c3f22a9047be48b1)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (rust/target/debug/deps/pp_drivers-d66d012d09dd07b7)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (rust/target/debug/deps/pp_gateway-bd173cb45a68f802)

running 9 tests
test spa_tests::spa_client_paths_match_the_node_router ... ok
test tests::admission_and_drain_share_one_barrier ... ok
test tests::effectful_get_is_explicit ... ok
test tests::encoded_artifact_segments_preserve_safe_names_and_reject_ambiguity ... ok
test tests::global_options_denial_remains_universal ... ok
test tests::manifest_wildcards_preserve_methods_and_aliases ... ok
test tests::operation_sort_preserves_exact_static_parameter_and_wildcard_priority ... ok
test tests::shutdown_request_observation_is_monotonic ... ok
test tests::wildcard_requires_its_slash_boundary ... ok

test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.15s

     Running unittests src/lib.rs (rust/target/debug/deps/pp_net-f56456052d2e290b)

running 3 tests
test target::tests::ambiguous_or_invalid_segments_are_denied ... ok
test target::tests::encoded_segments_are_canonical_before_signing ... ok
test target::tests::raw_and_encoded_control_characters_are_denied ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/main.rs (rust/target/debug/deps/pp_server-4a94ee4dde9425ed)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (rust/target/debug/deps/pp_services-8c23d7fc4ea3c5bc)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (rust/target/debug/deps/pp_source-25515ed6f4606e38)

running 2 tests
test media::tests::slug_matches_node_unicode_17_for_every_scalar ... ok
test path_policy::tests::full_default_folding_is_normalized_and_locale_independent ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 6.14s

     Running unittests src/main.rs (rust/target/debug/deps/pp_source-b534a95b26f32c07)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/bin/pp-source-archive.rs (rust/target/debug/deps/pp_source_archive-75a34d8f784346d4)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/bin/pp-source-media.rs (rust/target/debug/deps/pp_source_media-9fd6d0ebb01addcb)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/archive.rs (rust/target/debug/deps/archive-2cb7ce7b0e53e66d)

running 13 tests
test abandoned_candidate_symlink_is_unlinked_without_following_it ... ok
test archive_and_snapshot_reject_the_same_unicode_tree_collisions ... ok
test cancellation_during_input_copy_cleans_private_stage ... ok
test cli_invalid_revision_cleans_extraction_and_preserves_published_snapshot ... ok
test decomposed_archive_names_reject_without_normalizing_published_paths ... ok
test disk_sentinels_without_zip64_metadata_are_rejected ... ok
test dropping_unused_readiness_cleans_and_releases_the_stage ... ok
test input_file_and_source_roots_remain_pinned_after_path_replacement ... ok
test input_symlink_is_rejected_before_extraction ... ok
test live_readiness_rejects_another_extraction_without_consuming_its_stage ... ok
test owned_extraction_feeds_snapshot_and_cleanup_preserves_published_bytes ... ok
test symlinked_archive_parent_cannot_redirect_output ... ok
test zip64_disk_sentinels_resolve_to_single_disk ... ok

test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.60s

     Running tests/capabilities.rs (rust/target/debug/deps/capabilities-d72e6e510f87bb84)

running 6 tests
test changed_policy_and_bytes_reuse_original_publication ... ok
test conflicting_directory_case_is_rejected_before_copying ... ok
test input_handle_survives_input_path_replacement ... ok
test max_flat_snapshot_publishes_and_retries_cleanly ... ok
test source_handle_survives_repos_path_replacement_without_following_it ... ok
test zero_source_and_unsafe_revision_do_not_publish ... ok

test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 36.36s

     Running tests/media.rs (rust/target/debug/deps/media-be9944ba64c2ea74)

running 7 tests
test cancelled_live_conversion_cleans_derived_files_and_retries ... ok
test conversion_owns_candidate_and_published_original_and_derived_bytes_survive_reuse ... ok
test discovery_keeps_empty_directories_and_uses_filesystem_name_order_with_printables_after_directories ... ok
test failure_after_writing_a_facet_cleans_all_private_files_and_retry_succeeds ... ok
test original_capability_survives_path_replacement_and_output_symlinks_are_confined ... ok
test original_derived_collisions_refuse_without_overwrite ... ok
test package_larger_than_archive_cap_uses_media_limits ... ok

test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 8.40s

     Running unittests src/lib.rs (rust/target/debug/deps/pp_storage-c2213e86eccf4d77)

running 21 tests
test auth::tests::bounded_auth_workers_and_cancelled_queue_do_not_write ... ok
test auth::tests::ticket_t_17_transaction_cas_rejects_verified_login_after_public_reset ... ok
test auth::tests::verified_short_legacy_password_logs_in_without_rehashing ... ok
test catalog::tests::ticket_t_59_catalog_private_full_queue_retains_unreleased_work ... ok
test jobs::tests::job_document_exact_size_limit_saves_and_decodes ... ok
test jobs::tests::job_document_over_size_limit_rejects_without_any_writes ... ok
test storage_lease::tests::child_marker_requires_complete_info_and_a_stale_child ... ok
test storage_lease::tests::matching_process_identity_remains_live ... ok
test tests::ahead_and_old_versions_reject_before_side_effects ... ok
test tests::backup_cannot_replace_the_open_database ... ok
test tests::backup_includes_uncheckpointed_wal ... ok
test tests::backup_rejects_managed_trees_aliases_and_existing_files ... ok
test tests::backup_survives_missing_runtime_without_relaxing_destination_checks ... ok
test tests::directory_lease_cleanup_failure_retains_lock_until_retry ... ok
test tests::failed_cleanup_retains_marker_and_lock_until_explicit_retry ... ok
test tests::queue_cancellation_reply_loss_and_shutdown_drain ... ok
test tests::reader_pool_resets_pragmas_rejects_writes_and_is_bounded ... ok
test tests::reopen_preserves_the_pre_upgrade_backup ... ok
test tests::settings_are_atomic_and_tenant_scoped ... ok
test tests::unproved_closure_cannot_be_released_by_cleanup_retry ... ok
test tests::wal_only_unsupported_versions_preserve_every_input_file ... ok

test result: ok. 21 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 35.98s

     Running unittests src/bin/auth-fixture.rs (rust/target/debug/deps/auth_fixture-49b336ed0ca8d968)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/bin/catalog-fixture.rs (rust/target/debug/deps/catalog_fixture-5498234bb2e23fa8)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/bin/jobs-fixture.rs (rust/target/debug/deps/jobs_fixture-1ad8944ea24a1f59)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/bin/plan-read-fixture.rs (rust/target/debug/deps/plan_read_fixture-041ac73ea48370e8)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/bin/storage-fixture.rs (rust/target/debug/deps/storage_fixture-7af7f2d6e4b50709)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/auth_operations.rs (rust/target/debug/deps/auth_operations-e63305eb525466a2)

running 10 tests
test resolved_oauth_session_preserves_authenticated_provider_after_reopen ... ok
test session_provider_migrates_old_rows_and_rejects_unknown_values ... ok
test ticket_t_17_credentials ... ok
test ticket_t_17_hostile_costs_reject_before_hashing ... ok
test ticket_t_17_identity_and_tenant_keys ... ok
test ticket_t_17_key_collection_growth_rejects_atomically ... ok
test ticket_t_17_key_rotation_rollback ... ok
test ticket_t_17_missing_and_expired_sessions ... ok
test ticket_t_17_reset_rollback_and_cancellation ... ok
test ticket_t_17_sessions ... ok

test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 37.36s

     Running tests/catalog_operations.rs (rust/target/debug/deps/catalog_operations-aa02dd7231c14fe9)

running 16 tests
test catalog_key_audit_commits_protected_deletion_outcomes_and_rolls_back_errors ... ok
test catalog_rename_requires_a_name_and_preserves_unique_index_enforcement ... ok
test ticket_t_59_catalog_build_json_and_scoped_note_references ... ok
test ticket_t_59_catalog_categories_naming_and_import_invalidation ... ok
test ticket_t_59_catalog_crud_owner_restart_and_cancelled_lost_reply ... ok
test ticket_t_59_catalog_deletion_retains_files_and_counts_docs ... ok
test ticket_t_59_catalog_immutable_and_reference_graphs ... ok
test ticket_t_59_catalog_legacy_names_cannot_be_renamed_out_of_history ... ok
test ticket_t_59_catalog_metadata_rejection_and_legacy_bytes ... ok
test ticket_t_59_catalog_no_payload_paths_or_forged_authority ... ok
test ticket_t_59_catalog_public_backpressure ... ok
test ticket_t_59_catalog_regex_complexity_rejection_preserves_writer_and_settings ... ok
test ticket_t_59_catalog_rejections_preserve_rows_and_import_transaction ... ok
test ticket_t_59_catalog_session_key_owner_isolation_and_revocation ... ok
test ticket_t_59_catalog_work_delete_ordering ... ok
test ticket_t_59_catalog_work_races_delete_through_shared_writer ... ok

test result: ok. 16 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 28.35s

     Running tests/durable_jobs.rs (rust/target/debug/deps/durable_jobs-41f8f78c16e0a5ad)

running 75 tests
test active_and_failed_parents_cannot_authorize_start ... ok
test admitted_unconfirmed_upload_reaches_uploaded_only ... ok
test archived_parent_tenant_and_child_binding_corruptions_fail_without_writes ... ok
test archived_started_child_blocks_new_key_and_replays_original_key ... ok
test archived_uploaded_only_document_keeps_denied_and_confirmed_effect_facts ... ok
test bound_printer_start_finish_none_uses_confirmed_start_receipt ... ok
test confirmed_combined_receipt_cannot_be_rewritten ... ok
test confirmed_spoolman_rejects_changed_or_denied_outcome ... ok
test confirmed_spoolman_settles_to_upload_receipt_and_subject_audit ... ok
test denied_effect_on_running_fails_get ... ok
test denied_start_child_failure_allows_only_a_fresh_deliberate_key ... ok
test denied_start_settles_uploaded_only_and_authorizes_bound_child ... ok
test denying_spoolman_deduction_preserves_confirmed_print ... ok
test duplicate_confirmed_upload_parent_rejects_read_and_bind_but_allows_restart ... ok
test effect_outcome_wire_is_legacy_compatible_and_omits_false ... ok
test empty_scoped_sync_does_not_reserve_any_source ... ok
test filename_grouping_normalizes_before_hashing_and_persistence ... ok
test filename_grouping_rejects_padded_reserved_labels_before_admission ... ok
test gre_526_startup_and_load_skip_and_log_invalid_saved_rows ... ok
test integration_drop_and_orderly_restart_keep_source_reservations ... ok
test integration_individual_uncertain_reservation_survives_restart_and_matching_success ... ok
test integration_source_bridge_expiry_and_cancelled_admission ... ok
test integration_source_bridge_rejects_foreign_worker_missing_source_and_non_source_attempt ... ok
test integration_source_id_reservations_and_live_lease_have_distinct_lifetimes ... ok
test integration_wildcard_lookup_and_reservations_are_tenant_owned ... ok
test integration_wildcard_uncertainty_and_abandon_guard_until_matching_resolution ... ok
test invalid_attempts_do_not_consume_worker_capacity_but_keep_printer_reservations ... ok
test invalid_persisted_effect_outcomes_fail_closed ... ok
test legacy_scoped_sync_wildcard_column_reopens_with_payload_scope ... ok
test list_limit_skips_invalid_newest_rows_and_returns_a_usable_cursor ... ok
test live_child_binding_corruption_fails_get ... ok
test non_uploaded_confirmed_receipt_mismatch_fails_get ... ok
test persisted_effect_outcome_truth_table_accepts_exactly_three_shapes ... ok
test printer_finish_rejects_ancillary_result_then_accepts_primary_receipt ... ok
test reachable_printer_reconciliation_truth_table_has_no_stranded_shape ... ok
test reconciliation_does_not_infer_start_or_combined_outcomes ... ok
test retained_parent_rejects_embedded_job_id_mismatch_without_writes ... ok
test schema35_auxiliary_indexes_install_and_reopen ... ok
test scoped_sync_reserves_and_leases_only_listed_sources ... ok
test split_printer_upload_reconciles_to_uploaded_only ... ok
test spoolman_before_upload_settles_without_order_dependence ... ok
test start_child_cannot_finish_without_confirmed_start ... ok
test start_child_rejects_wrong_target_and_basis ... ok
test succeeded_and_nonprinter_parents_cannot_authorize_start ... ok
test ticket_t_28_claims_cancel_before_admission_running_and_effect ... ok
test ticket_t_28_claims_duplicate_concurrent_enqueue_and_no_handler_admission ... ok
test ticket_t_28_claims_duplicate_conflict_and_concurrent_claims ... ok
test ticket_t_28_claims_expired_lease_fences_old_worker ... ok
test ticket_t_28_claims_invalid_payloads_fail_before_writes ... ok
test ticket_t_28_claims_kind_resource_capacity_and_source_intent ... ok
test ticket_t_28_claims_list_filters_pagination_and_history ... ok
test ticket_t_28_claims_lost_reply_drain_and_backup_committed_job ... ok
test ticket_t_28_claims_ordinary_transaction_error_rolls_back ... ok
test ticket_t_28_claims_real_auth_tenant_policy_and_revocation ... ok
test ticket_t_28_claims_schema35_corruption_and36_preserve_input_bytes ... ok
test ticket_t_28_claims_schema35_migration_rollback_and_backup_restart ... ok
test ticket_t_28_claims_single_account_maps_default_and_physical_owner_is_opaque ... ok
test ticket_t_28_claims_wire_job_kinds_match_existing_contract ... ok
test ticket_t_28_recovery_abandon_keeps_uncertain_proof_and_resource_lock ... ok
test ticket_t_28_recovery_confirmed_local_candidate_requires_exact_receipt ... ok
test ticket_t_28_recovery_every_existing_kind_has_incomplete_intent_policy ... ok
test ticket_t_28_recovery_global_and_per_tenant_history_limits ... ok
test ticket_t_28_recovery_lost_claim_reply_is_fenced_on_orderly_restart ... ok
test ticket_t_28_recovery_old_completed_history_expires_but_uncertainty_survives ... ok
test ticket_t_28_recovery_orderly_restart_and_subject_bound_reconciliation ... ok
test ticket_t_28_recovery_receipts_duplicate_effects_and_finish ... ok
test ticket_t_28_recovery_reconciliation_records_authenticated_subject ... ok
test ticket_t_28_recovery_retention_preserves_uncertainty_and_idempotency ... ok
test ticket_t_28_recovery_success_requires_effect_receipts ... ok
test unresolved_spoolman_settles_by_either_explicit_decision ... ok
test uploaded_only_does_not_consume_active_queue_capacity ... ok
test uploaded_only_parent_authorizes_one_bound_start_without_reupload ... ok
test uploaded_only_parent_is_inert ... ok
test uploaded_only_persisted_proof_rejects_independent_corruptions ... ok
test uploaded_only_result_tamper_rejects_decode_and_child_binding ... ok

test result: ok. 75 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 149.72s

     Running tests/ticket_t_61_read_model.rs (rust/target/debug/deps/ticket_t_61_read_model-3e7d58bea4ab8728)

running 28 tests
test read_model_folder_rule_without_functional_class_matches_catalog_digest ... ok
test read_model_plan_configuration_freshness_does_not_make_sources_stale ... ok
test ticket_t_61_read_model_admission_bounds ... ok
test ticket_t_61_read_model_collation_matches_measured_node ... ok
test ticket_t_61_read_model_digest ... ok
test ticket_t_61_read_model_entire_batch_one_wal_snapshot ... ok
test ticket_t_61_read_model_fixture_has_recorded_hash ... ok
test ticket_t_61_read_model_foreign_and_missing_are_indistinguishable ... ok
test ticket_t_61_read_model_foreign_progress ... ok
test ticket_t_61_read_model_input_tenant ... ok
test ticket_t_61_read_model_js_canonical_timestamp ... ok
test ticket_t_61_read_model_key_route_is_authorized_by_secret_only ... ok
test ticket_t_61_read_model_mapping_digest ... ok
test ticket_t_61_read_model_missing_observations_are_errors ... ok
test ticket_t_61_read_model_missing_snapshot ... ok
test ticket_t_61_read_model_missing_unit ... ok
test ticket_t_61_read_model_node_graph_no_writes ... ok
test ticket_t_61_read_model_partial_unit_set ... ok
test ticket_t_61_read_model_plate_and_history_corruption_is_explicit ... ok
test ticket_t_61_read_model_pointer ... ok
test ticket_t_61_read_model_progress ... ok
test ticket_t_61_read_model_projection ... ok
test ticket_t_61_read_model_revision_tenant ... ok
test ticket_t_61_read_model_revocation_and_restart ... ok
test ticket_t_61_read_model_source_digest ... ok
test ticket_t_61_read_model_text_budget ... ok
test ticket_t_61_read_model_unsafe_snapshot ... ok
test ticket_t_61_read_model_workflow_rejects_unsafe_numbers ... ok

test result: ok. 28 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 18.12s

   Doc-tests pp_api

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests pp_api_types

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests pp_compat

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests pp_contracts

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests pp_core

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests pp_domain

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests pp_drivers

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests pp_gateway

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests pp_net

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests pp_services

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests pp_source

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests pp_storage

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

```

</details>

<details><summary>Initial parallel failure (exit 101)</summary>

Command: `cargo test --locked --manifest-path rust/Cargo.toml`

```text
failures:

---- ticket_t_17_hostile_costs_reject_before_hashing stdout ----

thread 'ticket_t_17_hostile_costs_reject_before_hashing' (291529) panicked at crates/pp-storage/tests/auth_operations.rs:714:5:
assertion failed: start.elapsed() < Duration::from_secs(1)
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace


failures:
    ticket_t_17_hostile_costs_reject_before_hashing

test result: FAILED. 9 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 15.05s

error: test failed, to rerun pass `-p pp-storage --test auth_operations`
```

</details>

<details><summary>Final lint and layout receipts (exit 0)</summary>

`cargo clippy --locked --manifest-path rust/Cargo.toml --all-targets -- -D warnings`

```text
    Checking pp-compat v0.1.0 (/persist/worktrees/t3/PrintPartner/bot-gre-354-wt-1645/rust/crates/pp-compat)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 2.00s
```

`cargo fmt --all --check --manifest-path rust/Cargo.toml`: exit 0, no output.

`git diff --check`: exit 0, no output.

`python3 rust/scripts/check-boundaries.py --self-test`

```text
{"packages": 14, "allowed_edges": true, "intentional_violation_rejected": true}
```

</details>

Earlier receipts below refer to their explicitly named older commits; their review/CI status is historical.

---

### Real Linux tray and window evidence — `743953a8cb7abb0f4bad4a06c816435eaf43dc1b`

Exemption: none. Built and run from an isolated checkout of this PR head, with measured runtime resources and fresh temporary data.

Reproduction: install the locked web dependencies (or copy an installation with the identical lockfile); `VITE_PRINT_PARTNER_DESKTOP=1 npm --prefix web run build`; `python3 rust/scripts/stage-desktop.py --web web --node <absolute-node> --output <new-stage> --commit 743953a8cb7abb0f4bad4a06c816435eaf43dc1b`; reuse an existing measured web stage only when it records this identical source commit. Before native compilation, clear all local workspace package outputs with `cargo clean --manifest-path rust/Cargo.toml -p <each-workspace-package>`; registry dependency artifacts may remain cached. Workspace crates were then rebuilt with `RUSTC_WRAPPER=`. `PP_DESKTOP_RELEASE_MANIFEST=<stage>/bundle-manifest.json CARGO_BUILD_JOBS=4 cargo build --manifest-path rust/Cargo.toml --locked -p pp-desktop`; launch the saved binary with `DISPLAY=:99 pp-desktop --dev-stage <stage> --data <fresh-data>`. Capture with `evidence shot <window-name> --window '^Print Partner$'`, `evidence tray-click printpartner`, and `evidence shot <tray-name> --tray`; upload with `evidence publish 134 <images>`.

Observed: the native app window and tray menu render at the named commit. The tray shows Show Print Partner, Service ready, guarded Restart service, and Quit Print Partner. Stopping the owned instance completed with a clean shutdown receipt. Captures were inspected before publishing and show app UI only. This is Linux desktop-shell smoke evidence; the existing scoped domain/CLI evidence remains separate, and these screenshots do not prove every feature of this stack layer or native macOS rendering.

![Native Print Partner window](https://github.com/poitee/PrintPartner/raw/evidence/desktop/jobs-domain-integration/20261010T191700Z/pr134-743953a8-fresh-20261010T191608Z-window.png)

![Native Print Partner tray menu](https://github.com/poitee/PrintPartner/raw/evidence/desktop/jobs-domain-integration/20261010T191700Z/pr134-743953a8-fresh-20261010T191608Z-tray.png)



Exemption: internal (`pp-storage`); this storage-only change has no user-visible UI.

Head: `743953a8cb7abb0f4bad4a06c816435eaf43dc1b`. Fix: [finish bound starts and scope Sync reservations](https://github.com/poitee/PrintPartner/commit/743953a8cb7abb0f4bad4a06c816435eaf43dc1b), built directly on `e69c3fe155c301f7c26f0227b5fa72620929fcec` and pushed normally. Author and committer: `915726+poitee@users.noreply.github.com`.

- Bound `PrinterStart` children now complete through `Finish(None)` using the confirmed start receipt matching their retained upload binding. Missing/unconfirmed starts still cannot finish.
- Scoped Sync stores a source-set reservation, permits leases only for listed ids, blocks overlapping jobs/deletion, and permits unrelated source work/deletion. Global Sync and CheckSourceUpdates retain wildcard ownership. Healthy legacy scoped rows with a `source:*` column reopen using their validated payload scope and rewrite the column on save; quarantined rows retain their stored reservation.

**Tests and lint (Linux, this head)**

`cargo test -p pp-storage -- --test-threads=1`: **147 passed, 0 failed**. Run from `rust/`.

```text
test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 33.78s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 39.48s
test result: ok. 16 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 26.39s
test result: ok. 75 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 159.12s
test result: ok. 28 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 19.67s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

New tests:
- `bound_printer_start_finish_none_uses_confirmed_start_receipt`
- `scoped_sync_reserves_and_leases_only_listed_sources`
- `legacy_scoped_sync_wildcard_column_reopens_with_payload_scope`
- `empty_scoped_sync_does_not_reserve_any_source`

Before/after proof: on the unchanged e69c3fe1 production code, the child regression failed (0 passed, 1 failed) at `Finish(None)` with `Completion requires effect receipts`; the scoped Sync regression failed (0 passed, 1 failed) because unrelated deletion returned `ActiveWork`. Both focused tests passed after the fix (1 passed, 0 failed each). The existing `start_child_cannot_finish_without_confirmed_start` test also now expects success after confirmation while retaining its rejection checks before confirmation. The first full run exposed that obsolete assertion (durable jobs: 74 passed, 1 failed); the final full run above passes.

`cargo fmt --check`: passed. `cargo clippy -p pp-storage --all-targets -- -D warnings`: passed. `git diff --check`: passed.

**Bugbot threads**

Both fixed, replied with this commit and test names, and resolved through `gh api graphql` / `resolveReviewThread`:
- [Child start ignores Finish fallback](https://github.com/poitee/PrintPartner/pull/134#discussion_r4237730830)
- [Scoped sync owns every source](https://github.com/poitee/PrintPartner/pull/134#discussion_r4237730836)

**Cursor Bugbot: SUCCESS** on this head ([check run](https://github.com/poitee/PrintPartner/pull/134/checks?check_run_id=114279030260)); completed review with no issues found. **Greptile Review: SUCCESS**, 5/5 confidence, no new actionable findings ([review](https://github.com/poitee/PrintPartner/pull/134#issuecomment-6072688953)). The exact `@greptileai review` request was posted. **All checks now pass**, including both macOS bundle jobs. Fresh autopilot state: `nextAction: ready`, `MERGEABLE`, `CLEAN`, no conflicts, no pending/failing checks, and no unresolved review threads. PR #134 remains unmerged; Chad's threads were not changed.

**Rust CI gap**

There is **no Rust CI job running the pp-storage test suite on PRs targeting `desktop/domain-family-integration`**. Inspected every `.github/workflows` file on `origin/desktop/domain-family-integration`. `desktop-runtime.yml` accepts Rust-changing PRs to this base but tests `pp-core`, `pp-compat`, `pp-gateway`, and `pp-server`, excluding `pp-storage`. `desktop-native-macos.yml` tests `pp-compat`. The other workflows do not run Rust tests. CI compiles pp-storage as a dependency, but that does not run its regression tests. No workflows were changed.

### Evidence — Cargo.lock normalization (2ea4066)

The macOS `bundle` jobs (run 38087268848) failed at `git diff --exit-code` because the `pp-api-types`, `pp-domain`, `pp-drivers`, `pp-net` and `pp-services` lock entries had been appended after `zlib-rs`. Commit 2ea4066 lets cargo put them back in sorted order.

- `git diff --stat 9b2d8da 2ea4066`: `rust/Cargo.lock | 66 +++---- (33 insertions, 33 deletions)`. This is only a reorder: the parsed package set is identical (535 packages, no version or checksum changes).
- At 2ea4066: `cargo build --locked --manifest-path rust/Cargo.toml` succeeds, then `git diff --exit-code rust/Cargo.lock` is clean (exit 0).

<!-- CURSOR_SUMMARY -->
---

> [!NOTE]
> **High Risk**
> Introduces schema migration, auth-scoped job APIs, and reconciliation logic for uncertain printer/source effects—core storage and tenancy paths with broad regression surface.
> 
> **Overview**
> Adds a **durable job queue** in `pp-storage` (schema **35**): SQLite-backed enqueue/idempotency, worker claims with leases and effect admission/reconciliation, printer upload/start binding, and **source/printer resource reservations** wired into catalog deletion and job-scoped source work. Job submission uses the same **session/API-key tenant policy** as catalog (extended in `auth_http` tests).
> 
> Splits the Rust workspace for the domain-family layout: **autosave wire types** move to `pp-domain` + `pp-api-types` (with `pp-contracts` re-exporting); gateway HTTP target parsing moves to **`pp-net`**; **`pp-drivers`** / **`pp-services`** are empty placeholders. Boundary checks and desktop-contract verification follow the new crates.
> 
> **CI** runs Rust `nextest` in **two parallel partitions** with an aggregate gate job. **Contributing docs** add a desktop/tray evidence capture workflow (D-Bus menu activation, head-SHA build).
> 
> <sup>Reviewed by [Cursor Bugbot](https://cursor.com/bugbot) for commit 2ea4066bda32d85d907d2296a240addaa66d15a5. Bugbot is set up for automated code reviews on this repo. Configure [here](https://www.cursor.com/dashboard/bugbot).</sup>
<!-- /CURSOR_SUMMARY -->





