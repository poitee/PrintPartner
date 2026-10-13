# GRE-408 verification artifacts

Existing PR [#134](https://github.com/poitee/PrintPartner/pull/134) owns the durable schema and storage claims. No duplicate PR or route cutover was created.

Baseline head was 2254b567a48f12f9de8fc4f23321695753ca66cf. The package claims filter passed 14 tests, and the serial storage suite passed 151 tests. The first workspace filter failed to build because the measured desktop manifest had not yet been generated. After installing and building the desktop assets and generating that manifest, the exact requested workspace filter passed 14 tests.

The initial crash test failed on production restart with `Data directory already owned`. The final trimmed test reproduced the failure on unchanged production code in crash-red-reproduced.log with exit 101 and 0 passed, 1 failed. A draft workaround that deleted the marker was rejected. Its draft run logs crash-retry-test.log and crash-red-before-fix.log are not accepted verification evidence and are excluded from publication. The final test restarts through public WriterOwner without deleting or rewriting the crashed owner marker.

The production ownership audit remains incomplete for GRE-408. All 28 job route aliases are compatibility-owned. Storage-only behavior does not establish the required complete route and worker switch. The independent audit also identified missing dedicated SQLITE_FULL coverage and damaged queued/reconciliation row visibility. Those are recorded as gaps, not changed in this scoped restart fix.

The evidence lint was extracted from origin/main because the desktop stack predates its script. lint-source-head.txt records the protected checker source SHA.

Focused results after the fix: crash test 1 passed, seven storage lease/marker checks passed, one schema-corruption case passed, nine real Core marker cases passed.

The implementation audit compared shared stale-owner validation with acquiring the lease before preflight. Shared validation preserves invalid-database preflight without ownership mutations. The old lease predicate was moved unchanged to one helper. Formatting, Clippy with warnings denied, boundary checks and diff whitespace checks passed.

Final required claims command: cargo nextest run --locked --manifest-path rust/Cargo.toml --no-tests=fail -E 'test(ticket_t_28_claims)'. Result: 15 tests run, 15 passed, 243 skipped. verified.diff and tested-source-sha256.json identify the tested working tree for comparison with the eventual commit. The measured manifest was generated from baseline asset commit 2254b567; assets and runtime ownership were not changed. Core marker tests use the same unchanged assets with the edited Rust storage sources.

Final commit d24091264eee977610588e375ff89bc31fa5440b. Committed source hashes match the tested files. Full serial storage suite: 152 tests run, 152 passed, 0 skipped.
