# GRE-648 PR 1 verification

Base: `093c4a79de0d7c091c77637980f21d70200d699d`. Branch: `gre-648-required-unit-test-gaps`.

This change adds tests and Node expectations only. The production portion of `required_units/model.rs` is byte-for-byte unchanged. No Rust-versus-Node mismatch was found. No side reviews ran.

Final Rust results: the default-feature suite passed all 303 tests. The complete feature suite ran 633 tests, with 632 passes, one known GRE-640 auth timeout, and one ignored test. The final isolated auth rerun passed. Both clippy configurations, formatting, and the Node fixture check passed.

Web quality stopped on an ownership-migration timeout. The isolated file rerun passed all 45 tests. The separately run accepted-STL file passed 26 tests and timed out on its 60-second stress test. The remaining quality stages, including browser checks, passed.

Node expectations come from `tests/fixtures/required-units/gaps-node.mjs`. See the adjacent README for regeneration and the mapping to literal model assertions.

## Mutation proof

The scratch copy was extracted with `git archive HEAD` into `/persist/worktrees/laneD/gre-648-mutants`, then overlaid with the new tests and fixtures. Each mutation was applied alone, its focused test was run, the original source was restored, and the same test was run again. The initial focused run also passed on the actual implementation worktree. Each counted mutant failed an assertion.

| Mutation | Focused test | Mutated | Restored |
| --- | --- | --- | --- |
| remove `surplus.sort()` | `surplus_tokens_are_sorted_independently_of_prior_indices` | FAIL, exit 100 | PASS, exit 0 |
| remove `rows.sort_by_key(...)` | `selection_basis_is_sorted_across_shrinking_predecessors` | FAIL, exit 100 | PASS, exit 0 |
| remove `source.is_some()` | `null_source_on_both_sides_does_not_make_an_exact_match` | FAIL, exit 100 | PASS, exit 0 |
| remove `target.artifact_digest.is_some()` | `null_artifact_on_both_sides_does_not_make_an_exact_match` | FAIL, exit 100 | PASS, exit 0 |
| remove revision-ID comparison, M11b | `changed_revision_with_equal_plan_version_returns_base_changed_without_selection_writes` | FAIL, exit 100 | PASS, exit 0 |
| extend with zero basis rows, extra tie assertion proof | `shrink_breaks_token_ties_and_restores_prior_index_order` | FAIL, exit 100 | PASS, exit 0 |

An initial extra tie probe deleted the basis write entirely and failed to compile with E0282 because the row type could no longer be inferred. That probe is not counted as a kill. The replacement extends with `basis(predecessor).into_iter().take(0)`, which preserves the type and emits no basis rows.

The revision test inserts revision 2, keeps profile and draft versions at 1, expects Node's complete `base_changed` response, and verifies the draft selection, reconciliation, assignment, and decision rows remain unchanged.

## Verification setup correction

An intermediate feature run reused a test binary with the scratch checkout embedded in `CARGO_MANIFEST_DIR`. Three migration tests looked for Node dependencies or Git history in that scratch copy. The run was interrupted after those fixture failures. The other two reported failures were the interrupted tests, not assertions. `cargo clean -p pp-storage` removed the reused artifacts. The next build forced a compiler-cache refresh, then migration probes checked the real worktree paths before the final suite. This changed no source code.

## Commands and results

Commands ran with `umask 022`. The runner also sets `TMPDIR=/persist/worktrees/laneD/gre-648-evidence/tmp`. Paths below are absolute so the scratch and real worktrees can be distinguished. Full stdout/stderr logs and the mutation patches are retained in `/persist/worktrees/laneD/gre-648-evidence/`.

Dependency installation ran first from `web`:

```sh
umask 022
cd /persist/worktrees/laneD/gre-648/web
npm ci
```

Exit 0. `added 719 packages, and audited 724 packages in 34s`; `found 0 vulnerabilities`. npm reported five dependency install scripts not yet covered by allowScripts.

### node-generate

```sh
cd /persist/worktrees/laneD/gre-648/web
node --conditions=development --import tsx ../rust/crates/pp-storage/tests/fixtures/required-units/gaps-node.mjs
```

Exit 0. Output:

```text
Wrote gaps-node.json from the Node required-unit service
```

### node-check

```sh
cd /persist/worktrees/laneD/gre-648/web
node --conditions=development --import tsx ../rust/crates/pp-storage/tests/fixtures/required-units/gaps-node.mjs --check
```

Exit 0. Output:

```text
gaps-node.json matches the Node required-unit service
```

### focused-head

```sh
cd /persist/worktrees/laneD/gre-648
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild -E 'test(required_units::model) | test(changed_revision_with_equal)'
```

Exit 0. Output:

```text
        PASS [   0.017s] (14/23) pp-storage required_units::model::tests::planning_uses_utf16_sorting_and_preserves_manifest_surrogates
        PASS [   0.014s] (15/23) pp-storage required_units::model::tests::surplus_tokens_are_sorted_independently_of_prior_indices
        PASS [   0.017s] (16/23) pp-storage required_units::model::tests::shrink_breaks_token_ties_and_restores_prior_index_order
        PASS [   0.014s] (17/23) pp-storage required_units::model::tests::token_validation_accepts_only_128_bit_lowercase_hex_tokens
        PASS [   0.017s] (18/23) pp-storage required_units::model::tests::selection_basis_is_sorted_across_shrinking_predecessors
        PASS [   0.018s] (19/23) pp-storage required_units::model::tests::prior_completion_reuses_only_completed_tokens_and_records_basis
        PASS [   0.017s] (20/23) pp-storage required_units::model::tests::shrink_prefers_completion_then_creation_time_then_token
        PASS [   0.015s] (21/23) pp-storage required_units::model::tests::unordered_predecessor_units_are_normalized_to_prior_indices
        PASS [   0.013s] (22/23) pp-storage required_units::model::tests::unsafe_predecessor_requires_a_decision_and_replace_creates_fresh_slots
        PASS [   1.772s] (23/23) pp-storage::required_unit_operations changed_revision_with_equal_plan_version_returns_base_changed_without_selection_writes
────────────
     Summary [   1.799s] 23 tests run: 23 passed, 611 skipped
```

### production-unchanged

```sh
cd /persist/worktrees/laneD/gre-648
python3 /persist/worktrees/laneD/gre-648-evidence/check-production.py
```

Exit 0. Output:

```text
PASS: model.rs production code is byte-for-byte unchanged; all edits are under #[cfg(test)].
```

### diff-check

```sh
cd /persist/worktrees/laneD/gre-648
git diff --check
```

Exit 0. Output:

```text
No output.
```

### fmt

```sh
cd /persist/worktrees/laneD/gre-648
cargo fmt --manifest-path rust/Cargo.toml --all --check
```

Exit 0. Output:

```text
No output.
```

### mutant-surplus-sort

```sh
cd /persist/worktrees/laneD/gre-648-mutants
env CARGO_TARGET_DIR=/persist/worktrees/laneD/gre-648/rust/target cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild -E 'test(surplus_tokens_are_sorted_independently_of_prior_indices)'
```

Exit 100. Output:

```text
        FAIL [   0.029s] (1/1) pp-storage required_units::model::tests::surplus_tokens_are_sorted_independently_of_prior_indices
    assertion `left == right` failed
      left: Object {"kind": String("ready"), "assignments": Array [], "surplus": Array [String("ppu_00000000000000000000000000000004"), String("ppu_00000000000000000000000000000001")], "selectionBasis": Array []}
     right: Object {"kind": String("ready"), "assignments": Array [], "surplus": Array [String("ppu_00000000000000000000000000000001"), String("ppu_00000000000000000000000000000004")], "selectionBasis": Array []}
     Summary [   0.049s] 1 test run: 0 passed, 1 failed, 633 skipped
        FAIL [   0.029s] (1/1) pp-storage required_units::model::tests::surplus_tokens_are_sorted_independently_of_prior_indices
```

### restored-surplus-sort

```sh
cd /persist/worktrees/laneD/gre-648-mutants
env CARGO_TARGET_DIR=/persist/worktrees/laneD/gre-648/rust/target cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild -E 'test(surplus_tokens_are_sorted_independently_of_prior_indices)'
```

Exit 0. Output:

```text
        PASS [   0.010s] (1/1) pp-storage required_units::model::tests::surplus_tokens_are_sorted_independently_of_prior_indices
     Summary [   0.012s] 1 test run: 1 passed, 633 skipped
```

### mutant-basis-sort

```sh
cd /persist/worktrees/laneD/gre-648-mutants
env CARGO_TARGET_DIR=/persist/worktrees/laneD/gre-648/rust/target cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild -E 'test(selection_basis_is_sorted_across_shrinking_predecessors)'
```

Exit 100. Output:

```text
        FAIL [   0.011s] (1/1) pp-storage required_units::model::tests::selection_basis_is_sorted_across_shrinking_predecessors
    assertion `left == right` failed
      left: Object {"kind": String("ready"), "assignments": Array [Object {"kind": String("reuse"), "draftPartId": Number(21), "unitIndex": Number(0), "token": String("ppu_00000000000000000000000000000003")}, Object {"kind": String("reuse"), "draftPartId": Number(22), "unitIndex": Number(0), "token": String("ppu_00000000000000000000000000000001")}], "surplus": Array [String("ppu_00000000000000000000000000000002"), String("ppu_00000000000000000000000000000004")], "selectionBasis": Array [Object {"revisionPartId": Number(11), "token": String("ppu_00000000000000000000000000000003"), "priorIndex": Number(0), "createdAt": String("2026-08-20T09:00:00.000Z"), "completed": Bool(false), "assembled": Bool(false)}, Object {"revisionPartId": Number(11), "token": String("ppu_00000000000000000000000000000004"), "priorIndex": Number(1), "createdAt": String("2026-08-20T09:00:00.000Z"), "completed": Bool(false), "assembled": Bool(false)}, Object {"revisionPartId": Number(10), "token": String("ppu_00000000000000000000000000000001"), "priorIndex": Number(0), "createdAt": String("2026-08-20T09:00:00.000Z"), "completed": Bool(false), "assembled": Bool(false)}, Object {"revisionPartId": Number(10), "token": String("ppu_00000000000000000000000000000002"), "priorIndex": Number(1), "createdAt": String("2026-08-20T09:00:00.000Z"), "completed": Bool(false), "assembled": Bool(false)}]}
     right: Object {"kind": String("ready"), "assignments": Array [Object {"kind": String("reuse"), "draftPartId": Number(21), "unitIndex": Number(0), "token": String("ppu_00000000000000000000000000000003")}, Object {"kind": String("reuse"), "draftPartId": Number(22), "unitIndex": Number(0), "token": String("ppu_00000000000000000000000000000001")}], "surplus": Array [String("ppu_00000000000000000000000000000002"), String("ppu_00000000000000000000000000000004")], "selectionBasis": Array [Object {"revisionPartId": Number(10), "token": String("ppu_00000000000000000000000000000001"), "priorIndex": Number(0), "createdAt": String("2026-08-20T09:00:00.000Z"), "completed": Bool(false), "assembled": Bool(false)}, Object {"revisionPartId": Number(10), "token": String("ppu_00000000000000000000000000000002"), "priorIndex": Number(1), "createdAt": String("2026-08-20T09:00:00.000Z"), "completed": Bool(false), "assembled": Bool(false)}, Object {"revisionPartId": Number(11), "token": String("ppu_00000000000000000000000000000003"), "priorIndex": Number(0), "createdAt": String("2026-08-20T09:00:00.000Z"), "completed": Bool(false), "assembled": Bool(false)}, Object {"revisionPartId": Number(11), "token": String("ppu_00000000000000000000000000000004"), "priorIndex": Number(1), "createdAt": String("2026-08-20T09:00:00.000Z"), "completed": Bool(false), "assembled": Bool(false)}]}
     Summary [   0.014s] 1 test run: 0 passed, 1 failed, 633 skipped
        FAIL [   0.011s] (1/1) pp-storage required_units::model::tests::selection_basis_is_sorted_across_shrinking_predecessors
```

### restored-basis-sort

```sh
cd /persist/worktrees/laneD/gre-648-mutants
env CARGO_TARGET_DIR=/persist/worktrees/laneD/gre-648/rust/target cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild -E 'test(selection_basis_is_sorted_across_shrinking_predecessors)'
```

Exit 0. Output:

```text
        PASS [   0.012s] (1/1) pp-storage required_units::model::tests::selection_basis_is_sorted_across_shrinking_predecessors
     Summary [   0.014s] 1 test run: 1 passed, 633 skipped
```

### mutant-source-guard

```sh
cd /persist/worktrees/laneD/gre-648-mutants
env CARGO_TARGET_DIR=/persist/worktrees/laneD/gre-648/rust/target cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild -E 'test(null_source_on_both_sides_does_not_make_an_exact_match)'
```

Exit 100. Output:

```text
        FAIL [   0.025s] (1/1) pp-storage required_units::model::tests::null_source_on_both_sides_does_not_make_an_exact_match
    assertion `left == right` failed
      left: Object {"kind": String("ready"), "assignments": Array [Object {"kind": String("reuse"), "draftPartId": Number(21), "unitIndex": Number(0), "token": String("ppu_0000000000000000000000000000000a")}], "surplus": Array [], "selectionBasis": Array []}
     right: Object {"kind": String("ready"), "assignments": Array [Object {"kind": String("create"), "draftPartId": Number(21), "unitIndex": Number(0)}], "surplus": Array [String("ppu_0000000000000000000000000000000a")], "selectionBasis": Array []}
     Summary [   0.037s] 1 test run: 0 passed, 1 failed, 633 skipped
        FAIL [   0.025s] (1/1) pp-storage required_units::model::tests::null_source_on_both_sides_does_not_make_an_exact_match
```

### restored-source-guard

```sh
cd /persist/worktrees/laneD/gre-648-mutants
env CARGO_TARGET_DIR=/persist/worktrees/laneD/gre-648/rust/target cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild -E 'test(null_source_on_both_sides_does_not_make_an_exact_match)'
```

Exit 0. Output:

```text
        PASS [   0.034s] (1/1) pp-storage required_units::model::tests::null_source_on_both_sides_does_not_make_an_exact_match
     Summary [   0.040s] 1 test run: 1 passed, 633 skipped
```

### mutant-artifact-guard

```sh
cd /persist/worktrees/laneD/gre-648-mutants
env CARGO_TARGET_DIR=/persist/worktrees/laneD/gre-648/rust/target cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild -E 'test(null_artifact_on_both_sides_does_not_make_an_exact_match)'
```

Exit 100. Output:

```text
        FAIL [   0.037s] (1/1) pp-storage required_units::model::tests::null_artifact_on_both_sides_does_not_make_an_exact_match
    assertion `left == right` failed
      left: Object {"kind": String("ready"), "assignments": Array [Object {"kind": String("reuse"), "draftPartId": Number(21), "unitIndex": Number(0), "token": String("ppu_0000000000000000000000000000000a")}], "surplus": Array [], "selectionBasis": Array []}
     right: Object {"kind": String("ready"), "assignments": Array [Object {"kind": String("create"), "draftPartId": Number(21), "unitIndex": Number(0)}], "surplus": Array [String("ppu_0000000000000000000000000000000a")], "selectionBasis": Array []}
     Summary [   0.055s] 1 test run: 0 passed, 1 failed, 633 skipped
        FAIL [   0.037s] (1/1) pp-storage required_units::model::tests::null_artifact_on_both_sides_does_not_make_an_exact_match
```

### restored-artifact-guard

```sh
cd /persist/worktrees/laneD/gre-648-mutants
env CARGO_TARGET_DIR=/persist/worktrees/laneD/gre-648/rust/target cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild -E 'test(null_artifact_on_both_sides_does_not_make_an_exact_match)'
```

Exit 0. Output:

```text
        PASS [   0.055s] (1/1) pp-storage required_units::model::tests::null_artifact_on_both_sides_does_not_make_an_exact_match
     Summary [   0.066s] 1 test run: 1 passed, 633 skipped
```

### mutant-M11b-revision-base

```sh
cd /persist/worktrees/laneD/gre-648-mutants
env CARGO_TARGET_DIR=/persist/worktrees/laneD/gre-648/rust/target cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild -E 'test(changed_revision_with_equal_plan_version_returns_base_changed_without_selection_writes)'
```

Exit 100. Output:

```text
        FAIL [   2.031s] (1/1) pp-storage::required_unit_operations changed_revision_with_equal_plan_version_returns_base_changed_without_selection_writes
    assertion `left == right` failed
      left: String("domain_error")
     right: "base_changed"
     Summary [   2.048s] 1 test run: 0 passed, 1 failed, 633 skipped
        FAIL [   2.031s] (1/1) pp-storage::required_unit_operations changed_revision_with_equal_plan_version_returns_base_changed_without_selection_writes
```

### restored-M11b-revision-base

```sh
cd /persist/worktrees/laneD/gre-648-mutants
env CARGO_TARGET_DIR=/persist/worktrees/laneD/gre-648/rust/target cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild -E 'test(changed_revision_with_equal_plan_version_returns_base_changed_without_selection_writes)'
```

Exit 0. Output:

```text
        PASS [   1.631s] (1/1) pp-storage::required_unit_operations changed_revision_with_equal_plan_version_returns_base_changed_without_selection_writes
     Summary [   1.636s] 1 test run: 1 passed, 633 skipped
```

### mutant-tie-basis

```sh
cd /persist/worktrees/laneD/gre-648-mutants
env CARGO_TARGET_DIR=/persist/worktrees/laneD/gre-648/rust/target cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild -E 'test(shrink_breaks_token_ties_and_restores_prior_index_order)'
```

Exit 101. Output:

```text
error[E0282]: type annotations needed for `&_`
   --> crates/pp-storage/src/required_units/model.rs:511:23
    |
511 |     rows.sort_by_key(|r| (r.revision_part_id, r.prior_index));
    |                       ^   ------------------ type must be known at this point
    |
help: consider giving this closure parameter an explicit type, where the type for type parameter `T` is specified
    |
511 |     rows.sort_by_key(|r: &T| (r.revision_part_id, r.prior_index));
    |                        ++++

For more information about this error, try `rustc --explain E0282`.
error: could not compile `pp-storage` (lib) due to 1 previous error
warning: build failed, waiting for other jobs to finish...
error: could not compile `pp-storage` (lib test) due to 1 previous error
error: command `/var/lib/agent-fleet-runtime-owner/runtime-root/releases/rust-1.99.0-db498dc4f4effd4b/bin/cargo '--color=auto' test --manifest-path rust/Cargo.toml --no-run --message-format json-render-diagnostics --package pp-storage --features desktop_rebuild --locked` exited with code 101
```

### web-quality

```sh
cd /persist/worktrees/laneD/gre-648/web
npm run quality
```

Exit 1. Output:

```text
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/ownership-migration.test.ts > runs gated inspect and apply through the CLI and reports invalid arguments
Error: Test timed out in 15000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ src/ownership-migration.test.ts:163:1


⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed | 329 passed | 1 skipped (331)
      Tests  1 failed | 4012 passed | 1 skipped (4014)
   Start at  21:19:41
   Duration  452.68s (transform 61.94s, setup 25.21s, import 925.11s, tests 2451.07s, environment 121ms)

npm error Lifecycle script `test:ci` failed with error:
npm error code 1
npm error path /persist/worktrees/laneD/gre-648/web/apps/server
npm error workspace @print-partner/server@0.1.0
npm error location /persist/worktrees/laneD/gre-648/web/apps/server
npm error command failed
npm error command sh -c vitest run --exclude src/services/accepted-stl-bundle.test.ts && vitest run src/services/accepted-stl-bundle.test.ts --maxWorkers=1 --no-file-parallelism
```

### mutant-tie-basis-empty

```sh
cd /persist/worktrees/laneD/gre-648-mutants
env CARGO_TARGET_DIR=/persist/worktrees/laneD/gre-648/rust/target cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild -E 'test(shrink_breaks_token_ties_and_restores_prior_index_order)'
```

Exit 100. Output:

```text
        FAIL [   0.067s] (1/1) pp-storage required_units::model::tests::shrink_breaks_token_ties_and_restores_prior_index_order
    assertion `left == right` failed
      left: Array []
     right: Array [Object {"revisionPartId": Number(10), "token": String("ppu_00000000000000000000000000000004"), "priorIndex": Number(0), "createdAt": String("2026-08-20T09:00:00.000Z"), "completed": Bool(true), "assembled": Bool(false)}, Object {"revisionPartId": Number(10), "token": String("ppu_00000000000000000000000000000003"), "priorIndex": Number(1), "createdAt": String("2026-08-20T09:00:00.000Z"), "completed": Bool(true), "assembled": Bool(false)}]
     Summary [   0.101s] 1 test run: 0 passed, 1 failed, 633 skipped
        FAIL [   0.067s] (1/1) pp-storage required_units::model::tests::shrink_breaks_token_ties_and_restores_prior_index_order
```

### restored-tie-basis-empty

```sh
cd /persist/worktrees/laneD/gre-648-mutants
env CARGO_TARGET_DIR=/persist/worktrees/laneD/gre-648/rust/target cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild -E 'test(shrink_breaks_token_ties_and_restores_prior_index_order)'
```

Exit 0. Output:

```text
        PASS [   0.035s] (1/1) pp-storage required_units::model::tests::shrink_breaks_token_ties_and_restores_prior_index_order
     Summary [   0.039s] 1 test run: 1 passed, 633 skipped
```

### web-ownership-isolated

```sh
cd /persist/worktrees/laneD/gre-648/web
npm exec --workspace @print-partner/server -- vitest run src/ownership-migration.test.ts --maxWorkers=1 --no-file-parallelism
```

Exit 0. Output:

```text

 RUN  v4.1.11 /persist/worktrees/laneD/gre-648/web/apps/server


 Test Files  1 passed (1)
      Tests  45 passed (45)
   Start at  21:28:57
   Duration  68.09s (transform 2.33s, setup 175ms, import 4.51s, tests 63.06s, environment 0ms)

```

### nextest-feature

```sh
cd /persist/worktrees/laneD/gre-648
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild
```

Exit 100. Output:

```text
    thread 'auth::rebuild::tests::verified_short_legacy_password_logs_in_without_rehashing' (1558771) panicked at crates/pp-storage/src/auth/rebuild/tests.rs:94:10:
    called `Result::unwrap()` on an `Err` value: Timeout
    note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace

  Cancelling due to test failure: 11 tests still running
        PASS [   0.290s] (168/633) pp-storage schema::capture_tests::ticket_t_12_postlease_descriptor_refuses_symlink_members
        PASS [   0.578s] (169/633) pp-storage required_units::tests::corrupt_rows_return_node_messages
        PASS [   0.339s] (170/633) pp-storage schema::capture_tests::ticket_t_12_postlease_refuses_changed_directory_before_early_returns
        PASS [   0.484s] (171/633) pp-storage schema::capture_tests::ticket_t_12_postlease_descriptor_refuses_special_members_without_blocking
        PASS [   2.614s] (172/633) pp-storage manifest_options::observation_tests::zero_budgets_refuse_the_stored_kit_and_import_rules
        PASS [   2.614s] (172/633) pp-storage manifest_options::observation_tests::zero_budgets_refuse_the_stored_kit_and_import_rules
        PASS [   1.884s] (173/633) pp-storage read_model::preparation_tests::accepted_base_reuse_and_freshness_match_literal_node_results
        PASS [   5.535s] (174/633) pp-storage manifest_options::observation_tests::import_arrays_over_the_node_limit_refuse_instead_of_dropping_parts
        PASS [  21.358s] (175/633) pp-storage auth::tests::verified_short_legacy_password_logs_in_without_rehashing
        PASS [  22.941s] (176/633) pp-storage auth::tests::ticket_t_17_transaction_cas_rejects_verified_login_after_public_reset
        PASS [   7.873s] (177/633) pp-storage native_secrets::tests::expired_admission_prevents_preparation_and_legacy_removal
        PASS [  23.911s] (178/633) pp-storage required_units::storage::tests::manifest_text_and_ppjs_bytes_count_toward_the_total_limit
────────────
     Summary [  44.278s] 178/633 tests run: 177 passed, 1 failed, 1 skipped
        FAIL [  20.858s] (167/633) pp-storage auth::rebuild::tests::verified_short_legacy_password_logs_in_without_rehashing
warning: 455/633 tests were not run due to test failure (run with --no-fail-fast to run all tests, or run with --max-fail)
error: test run failed
```

### web-accepted-stl-isolated

```sh
cd /persist/worktrees/laneD/gre-648/web
npm exec --workspace @print-partner/server -- vitest run src/services/accepted-stl-bundle.test.ts --maxWorkers=1 --no-file-parallelism
```

Exit 1. Output:

```text
       |   ^
    528|     const fixturePaths = fixture();
    529|     const base = part({ snapshotRoot: fixturePaths.snapshotRoot, compl…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 26 passed (27)
   Start at  21:30:07
   Duration  100.69s (transform 913ms, setup 174ms, import 1.28s, tests 98.86s, environment 0ms)

```

### nextest-default

```sh
cd /persist/worktrees/laneD/gre-648
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage
```

Exit 0. Output:

```text
        PASS [   1.053s] (294/303) pp-storage::ticket_t_7_writer_marker ticket_t_7_writer_marker_torn_lease_record_fails_closed
        PASS [  15.164s] (295/303) pp-storage::ticket_t_7_writer_marker ticket_t_7_writer_desktop_marker_legacy_standalone_recovers
        PASS [  28.923s] (296/303) pp-storage::ticket_t_7_writer ticket_t_7_writer_bounds_busy_and_rolls_back_a_killed_process
        PASS [  22.705s] (297/303) pp-storage::ticket_t_7_writer ticket_t_7_writer_reopens_after_clean_process_exit
        PASS [  16.185s] (298/303) pp-storage::ticket_t_7_writer_marker ticket_t_7_writer_marker_complete_stale_lease_recovers
        PASS [  26.524s] (299/303) pp-storage::ticket_t_7_writer ticket_t_7_writer_survives_kill_and_live_node_child
        PASS [  41.890s] (300/303) pp-storage::ticket_t_61_read_model ticket_t_61_read_model_plate_and_history_corruption_is_explicit
        PASS [  35.611s] (301/303) pp-storage::ticket_t_7_writer ticket_t_7_writer_busy_timeout_survives_a_delayed_reply_collector
        PASS [  58.944s] (302/303) pp-storage::ticket_t_61_read_model ticket_t_61_read_model_js_canonical_timestamp
        PASS [ 118.670s] (303/303) pp-storage::durable_jobs ticket_t_28_recovery_every_existing_kind_has_incomplete_intent_policy
────────────
     Summary [ 285.075s] 303 tests run: 303 passed (5 slow), 0 skipped
```

### web-workflow

```sh
cd /persist/worktrees/laneD/gre-648/web
npm run test:workflow-smoke
```

Exit 0. Output:

```text

> print-partner-web@3.3.0 test:workflow-smoke
> python3 -m unittest scripts.test_workflow_smoke

............
----------------------------------------------------------------------
Ran 12 tests in 14.760s

OK
```

### clippy-feature

```sh
cd /persist/worktrees/laneD/gre-648
cargo clippy --locked --manifest-path rust/Cargo.toml -p pp-storage --all-targets --features desktop_rebuild -- -D warnings
```

Exit 0. Output:

```text
    Checking argon2 v0.5.3
    Checking regress v0.11.1
    Checking scrypt v0.11.0
    Checking icu_collator v2.3.1
    Checking rand v0.9.5
    Checking anyhow v1.0.104
    Checking fs4 v1.1.0
    Checking fs2 v0.4.3
    Checking hex v0.4.3
    Checking ryu-js v1.0.2
    Checking pp-storage v0.1.0 (/persist/worktrees/laneD/gre-648/rust/crates/pp-storage)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1m 12s
```

### clippy-default

```sh
cd /persist/worktrees/laneD/gre-648
cargo clippy --locked --manifest-path rust/Cargo.toml -p pp-storage --all-targets -- -D warnings
```

Exit 0. Output:

```text
    Checking serde_core v1.0.228
    Checking icu_properties v2.3.0
    Checking icu_collator v2.3.1
    Checking serde v1.0.228
    Checking serde_json v1.0.145
    Checking pp-storage v0.1.0 (/persist/worktrees/laneD/gre-648/rust/crates/pp-storage)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 23.76s
```

### gre640-isolated

```sh
cd /persist/worktrees/laneD/gre-648
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib -E 'test(auth::rebuild::tests::verified_short_legacy_password_logs_in_without_rehashing)'
```

Exit 0. Output:

```text
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.41s
────────────
 Nextest run ID a73d6642-d50e-4189-b0d1-e49007dedf6f with nextest profile: default
    Starting 1 test across 1 binary (290 tests skipped)
        PASS [  18.649s] (1/1) pp-storage auth::rebuild::tests::verified_short_legacy_password_logs_in_without_rehashing
────────────
     Summary [  18.651s] 1 test run: 1 passed, 290 skipped
```

### web-build

```sh
cd /persist/worktrees/laneD/gre-648/web
npm run build
```

Exit 0. Output:

```text
dist/assets/PartsPage-BtDbyfST.js                    74.37 kB │ gzip:  21.10 kB
dist/assets/BrandMark-DRvbSg6D.js                    75.80 kB │ gzip:  22.60 kB
dist/assets/SourcesPage-D917NTCR.js                  88.89 kB │ gzip:  25.69 kB
dist/assets/jszip.min-BKkSLVCN.js                    95.94 kB │ gzip:  28.48 kB
dist/assets/SettingsPage-BI6cBur9.js                104.13 kB │ gzip:  25.39 kB
dist/assets/CheckoffPage-DOXbDyIU.js                109.04 kB │ gzip:  30.51 kB
dist/assets/ExportPage-hbWuViGs.js                  135.79 kB │ gzip:  39.27 kB
dist/assets/AuthenticatedApp-CCjDuUjo.js            196.18 kB │ gzip:  58.05 kB
dist/assets/index-RoJnfCS8.js                       450.73 kB │ gzip: 137.63 kB
dist/assets/previewRig-BQm806uM.js                  549.11 kB │ gzip: 137.52 kB

✓ built in 3.66s
```

### web-bundles

```sh
cd /persist/worktrees/laneD/gre-648/web
npm run test:bundles -w @print-partner/web
```

Exit 0. Output:

```text
ExportPage.tsx            authenticated  +209 KB  +68 KB
ForgotPasswordPage.tsx    public         +80 KB   +25 KB
GlobalProductionPage.tsx  authenticated  +56 KB   +20 KB
HelpPage.tsx              authenticated  +21 KB   +8 KB
LoginPage.tsx             public         +82 KB   +25 KB
NotFoundPage.tsx          authenticated  +1 KB    +0 KB
PartsPage.tsx             authenticated  +146 KB  +49 KB
PlansPage.tsx             authenticated  +19 KB   +7 KB
PrintersPage.tsx          authenticated  +87 KB   +32 KB
ResetPasswordPage.tsx     public         +80 KB   +25 KB
SettingsPage.tsx          authenticated  +219 KB  +68 KB
SourcesPage.tsx           authenticated  +209 KB  +69 KB
```

### scratch-model-restored

```sh
cd /persist/worktrees/laneD/gre-648
cmp rust/crates/pp-storage/src/required_units/model.rs /persist/worktrees/laneD/gre-648-mutants/rust/crates/pp-storage/src/required_units/model.rs
```

Exit 0. Output:

```text
No output.
```

### scratch-operation-restored

```sh
cd /persist/worktrees/laneD/gre-648
cmp rust/crates/pp-storage/src/required_units/reconcile.rs /persist/worktrees/laneD/gre-648-mutants/rust/crates/pp-storage/src/required_units/reconcile.rs
```

Exit 0. Output:

```text
No output.
```

### scratch-test-identical

```sh
cd /persist/worktrees/laneD/gre-648
cmp rust/crates/pp-storage/tests/required_unit_operations.rs /persist/worktrees/laneD/gre-648-mutants/rust/crates/pp-storage/tests/required_unit_operations.rs
```

Exit 0. Output:

```text
No output.
```

### web-runtime

```sh
cd /persist/worktrees/laneD/gre-648/web
npm run test:runtime
```

Exit 0. Output:

```text
✔ npm verification serves its advertised IPv4 URL and cleans up only its run (25373.257122ms)
✔ npm launch rejects an occupied UI port owned by another healthy instance (18685.528308ms)
✔ published server accepts the application's Docker release identity (89.388848ms)
✔ published server reads its PostgreSQL migration before opening a database connection (21.418049ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 44267.315484
```

### web-browser

```sh
cd /persist/worktrees/laneD/gre-648/web
npm run test:browser
```

Exit 0. Output:

```text
PASS: job observation fault witnesses {
PASS: transient job polls retry; non-retryable job poll stops the spinner; retry completes through HTTP polling without WebSocket
PASS: real upload, saved rules reload, Accent + Structural ZIP download with identical STL bytes, overlap warning, mobile layout { build: 1 }
PASS: Build color, catalog color, custom hex, validation, reload persistence, unchanged peers/roles/quantities/progress, mobile dialog { build: 1 }
```

### nextest-feature-complete

```sh
cd /persist/worktrees/laneD/gre-648
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --test-threads=2 --no-fail-fast
```

Exit 100. Output:

```text
    thread 'tests::ticket_t_7_migrations' (1581969) panicked at crates/pp-storage/src/tests.rs:1697:5:
    node fixture prepare failed: node:internal/modules/package_json_reader:314
      throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);
            ^

    Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from /persist/worktrees/laneD/gre-648-mutants/web/
        at Object.getPackageJSONURL (node:internal/modules/package_json_reader:314:9)
        at packageResolve (node:internal/modules/esm/resolve:772:81)
        at moduleResolve (node:internal/modules/esm/resolve:859:18)
        at defaultResolve (node:internal/modules/esm/resolve:989:11)
    thread 'tests::ticket_t_7_migrations_matches_node_upgrade' (1582054) panicked at crates/pp-storage/src/tests.rs:3113:5:
    historical Node client 71e25e7731feddd0eaec05a0d1070dc13de790a7 is unavailable: fatal: not a git repository (or any parent up to mount point /)
    Stopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).

    note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace

        FAIL [   1.996s] (208/633) pp-storage tests::ticket_t_7_migrations_preserves_plan_revision_inputs
  stdout ───

    running 1 test
    thread 'tests::ticket_t_7_migrations_preserves_plan_revision_inputs' (1582057) panicked at crates/pp-storage/src/tests.rs:3113:5:
    historical Node client 71e25e7731feddd0eaec05a0d1070dc13de790a7 is unavailable: fatal: not a git repository (or any parent up to mount point /)
    Stopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).

    note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace

        PASS [   0.113s] (209/633) pp-storage tests::ticket_t_7_migrations_preserves_refused_inputs
        PASS [   0.110s] (210/633) pp-storage tests::ticket_t_7_migrations_refuses_dispatcher_script
        PASS [   0.106s] (211/633) pp-storage tests::ticket_t_7_migrations_requires_pinned_runtime_identity
        PASS [   3.455s] (212/633) pp-storage tests::ticket_t_7_writer_bounds_queue_contention_and_cancellation
        PASS [   3.640s] (391/633) pp-storage::durable_jobs integration_source_bridge_expiry_and_cancelled_admission
        PASS [   2.004s] (392/633) pp-storage::durable_jobs integration_source_bridge_rejects_foreign_worker_missing_source_and_non_source_attempt
        PASS [   2.414s] (393/633) pp-storage::durable_jobs integration_source_id_reservations_and_live_lease_have_distinct_lifetimes
        PASS [   3.505s] (394/633) pp-storage::durable_jobs integration_wildcard_lookup_and_reservations_are_tenant_owned
        PASS [  13.124s] (395/633) pp-storage::durable_jobs integration_wildcard_uncertainty_and_abandon_guard_until_matching_resolution
  Cancelling due to interrupt: 2 tests still running
      SIGINT [  15.681s] (396/633) pp-storage::durable_jobs invalid_attempts_do_not_consume_worker_capacity_but_keep_printer_reservations
      SIGINT [   3.955s] (397/633) pp-storage::durable_jobs invalid_persisted_effect_outcomes_fail_closed
────────────
     Summary [ 432.593s] 397/633 tests run: 392 passed, 5 failed, 1 skipped
warning: 236/633 tests were not run due to interrupt
error: test run failed
```

### clean-storage

```sh
cd /persist/worktrees/laneD/gre-648
cargo clean --manifest-path rust/Cargo.toml -p pp-storage
```

Exit 0. Output:

```text
     Removed 848 files, 5.3GiB total
```

### migration-paths-clean

```sh
cd /persist/worktrees/laneD/gre-648
env SCCACHE_RECACHE=1 cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib -E 'test(ticket_t_7_migrations)' --test-threads=2
```

Exit 0. Output:

```text
────────────
 Nextest run ID f2804bfd-e7e5-497c-8588-41975fdc5b62 with nextest profile: default
    Starting 7 tests across 1 binary (284 tests skipped)
        PASS [  23.367s] (1/7) pp-storage tests::ticket_t_7_migrations_historical_order
        PASS [  24.820s] (2/7) pp-storage tests::ticket_t_7_migrations
        PASS [   9.823s] (3/7) pp-storage tests::ticket_t_7_migrations_preserves_plan_revision_inputs
        PASS [   0.166s] (4/7) pp-storage tests::ticket_t_7_migrations_preserves_refused_inputs
        PASS [   0.129s] (5/7) pp-storage tests::ticket_t_7_migrations_refuses_dispatcher_script
        PASS [   0.102s] (6/7) pp-storage tests::ticket_t_7_migrations_requires_pinned_runtime_identity
        PASS [  24.754s] (7/7) pp-storage tests::ticket_t_7_migrations_matches_node_upgrade
────────────
     Summary [  48.122s] 7 tests run: 7 passed, 284 skipped
```

### gre640-isolated-clean

```sh
cd /persist/worktrees/laneD/gre-648
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib -E 'test(auth::rebuild::tests::verified_short_legacy_password_logs_in_without_rehashing)'
```

Exit 0. Output:

```text
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.29s
────────────
 Nextest run ID 1f8ebe06-e658-4bd4-a487-deb84d124552 with nextest profile: default
    Starting 1 test across 1 binary (290 tests skipped)
        PASS [  17.713s] (1/1) pp-storage auth::rebuild::tests::verified_short_legacy_password_logs_in_without_rehashing
────────────
     Summary [  17.715s] 1 test run: 1 passed, 290 skipped
```

### nextest-feature-complete-clean

```sh
cd /persist/worktrees/laneD/gre-648
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --test-threads=4 --no-fail-fast
```

Exit 100. Output:

```text
    thread 'auth::rebuild::tests::verified_short_legacy_password_logs_in_without_rehashing' (1589979) panicked at crates/pp-storage/src/auth/rebuild/tests.rs:94:10:
    called `Result::unwrap()` on an `Err` value: Timeout
    note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace

        PASS [   1.589s] ( 14/633) pp-storage build_graph::tests::expired_writer_deadline_does_not_block_deferred_reads
        PASS [   1.943s] ( 15/633) pp-storage build_graph::tests::expired_mutations_skip_sql_and_preserve_timeout_before_fresh_mutation
        PASS [   0.019s] ( 16/633) pp-storage catalog::rebuild::tests::numeric_selectors_reject_nonfinite_deserialization
        PASS [   0.016s] ( 17/633) pp-storage catalog::tests::ticket_t_59_catalog_private_full_queue_retains_unreleased_work
        PASS [  20.967s] ( 18/633) pp-storage auth::tests::ticket_t_17_transaction_cas_rejects_verified_login_after_public_reset
        PASS [   7.171s] ( 19/633) pp-storage build_graph::tests::lost_reply_is_outcome_unknown
        PASS [   1.809s] (626/633) pp-storage::working_draft_writes edit_without_an_accepted_baseline_is_refused
        PASS [   3.283s] (627/633) pp-storage::working_draft_writes edit_of_a_selected_draft_replaces_its_selection
        PASS [   0.622s] (628/633) pp-storage::working_draft_writes requests_accept_what_node_contracts_accept
        PASS [   3.106s] (629/633) pp-storage::working_draft_writes failed_selection_errors_and_its_retry_selects
        PASS [   3.465s] (630/633) pp-storage::working_draft_writes failed_selection_keeps_the_edit_after_the_base_changes
        PASS [   1.956s] (631/633) pp-storage::working_draft_writes stale_digest_edit_is_draft_changed_without_writes
        PASS [   1.546s] (632/633) pp-storage::working_draft_writes unchanged_edit_with_a_stale_digest_selects_like_node
        PASS [   5.789s] (633/633) pp-storage::working_draft_writes missing_profile_draft_and_parts_are_not_found
────────────
     Summary [ 616.609s] 633 tests run: 632 passed (3 slow), 1 failed, 1 skipped
        FAIL [  23.453s] ( 13/633) pp-storage auth::rebuild::tests::verified_short_legacy_password_logs_in_without_rehashing
error: test run failed
```

### gre640-isolated-final

```sh
cd /persist/worktrees/laneD/gre-648
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib -E 'test(auth::rebuild::tests::verified_short_legacy_password_logs_in_without_rehashing)'
```

Exit 0. Output:

```text
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.40s
────────────
 Nextest run ID 82dd7dbe-3d32-4aab-a98f-d77662c55406 with nextest profile: default
    Starting 1 test across 1 binary (290 tests skipped)
        PASS [  19.082s] (1/1) pp-storage auth::rebuild::tests::verified_short_legacy_password_logs_in_without_rehashing
────────────
     Summary [  19.085s] 1 test run: 1 passed, 290 skipped
```

## Unslop and scope check

Checked the new tests, fixture generator, README, and evidence text for filler, speculative abstractions, and dead code. `git diff --check` passes. All model edits are under `#[cfg(test)]`; no production source changed.
