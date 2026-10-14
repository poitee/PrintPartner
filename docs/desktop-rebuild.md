# Desktop rebuild flag

GRE-596 adds a build gate and a runtime opt-in for the desktop rebuild in GRE-595. Both default to off.

The `desktop_rebuild` Cargo feature is available on `pp-core`, `pp-contracts`, and `pp-desktop`. The desktop feature enables the core feature. The contracts feature exposes the new `build_identity`, `reconciliation`, `publication`, and `working_drafts` modules. Existing autosave contracts stay available in both builds.

`CoreRuntime::start` reads `PP_DESKTOP_REBUILD` once at startup and stores the effective setting. `CoreRuntime::desktop_rebuild().enabled()` returns that setting. Only the exact values `1` and `true` enable it, and only when `pp-core` was compiled with `desktop_rebuild`. Missing, non-Unicode, empty, false, and unrecognized values produce false. The setting is process-local and does not change `desktop.toml` or persisted data.

D1 adds no routes, storage migrations, UI, or rebuild execution. The existing gateway and Node compatibility runtime continue to run even when both gates are enabled. Future rebuild behavior must check the stored runtime setting and compile behind the Cargo feature.

Build the native shell with the core gate enabled using its existing staging prerequisites:

```sh
PP_DESKTOP_REBUILD=true cargo run --locked --manifest-path rust/Cargo.toml -p pp-desktop --features desktop_rebuild
```

The contracts and core gates can be tested without a native shell:

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-contracts
cargo test --locked --manifest-path rust/Cargo.toml -p pp-contracts --features desktop_rebuild
cargo test --locked --manifest-path rust/Cargo.toml -p pp-core --lib
cargo test --locked --manifest-path rust/Cargo.toml -p pp-core --lib --features desktop_rebuild
```

Core tests isolate environment changes in child processes. They cover absent, disabled, invalid, and enabled values with and without the Cargo feature. The existing autosave consumer tests run in both contract builds. The Rust runtime proof checks the existing authenticated endpoints, source creation, response shapes, and shutdown with the runtime opt-in absent or false.

## Slice plan

The rebuild ships as small PRs to `main`, each under about 1.5k lines and checkable on its own. Every slice compiles behind the `desktop_rebuild` Cargo feature, and anything user-visible also checks the runtime setting. The default build stays unchanged. The old desktop stack (#135 to #168, `desktop/rust-core`, and the reference branch `desktop/source-sync-local-current-20261008`) is reference only. It is not merged, and it is not closed or deleted until the slices cover it.

Each slice is done when:

- the existing suites pass with the feature off and on, and the default build is unchanged;
- a reviewer engine other than the author's scores it above 8 on the exact head, with all checks green.

Slices land in this order. Linear tracks each one under GRE-595.

| Slice | Linear | Scope |
| --- | --- | --- |
| D1 | GRE-596 | Flag scaffold and pp-contracts additions (merged, #316) |
| D2 | GRE-597 | pp-core profile_interpreter |
| D3 | GRE-598 | pp-core review_observations, source_acquisition and uploads |
| D4 | GRE-599 | pp-source media |
| D5 | GRE-603 | pp-source retained_capture |
| D6 | GRE-605 | pp-storage auth and native_secrets |
| D7 | GRE-600 | pp-storage catalog core |
| D8 | GRE-601 | pp-storage catalog naming and tests |
| D9 | GRE-602 | pp-storage manifest_text and build_graph |
| D10 | GRE-604 | pp-storage build_graph manifest_options |
| D11 | GRE-606 | pp-storage required_units |
| D12 | GRE-607 | pp-storage working_drafts core, yaml and preparation |
| D13 | GRE-608 | pp-storage working_drafts save, manifest, rebase and siblings |
| D14 | GRE-610 | pp-storage uploads and capture_manifest |
| D15 | GRE-611 | pp-storage jobs model and subscriptions |
| D16 | GRE-609 | pp-storage jobs engine (3 PRs) |
| D17 | GRE-613 | pp-storage source_scan |
| D18 | GRE-614 | pp-storage source_sync |
| D19 | GRE-612 | pp-storage plan_publication |
| D20 | GRE-615 | pp-storage checkoff_progress |
| D21 | GRE-616 | pp-storage read_model context and graph |
| D22 | GRE-618 | pp-storage read_model workflow and views |
| D23 | GRE-617 | pp-api auth HTTP |
| D24 | GRE-619 | pp-api drafts HTTP |
| D25 | GRE-620 | pp-api builds HTTP and jobs |
| D26 | GRE-621 | Web and server wiring behind the flag |

Gap slices added in triage on 2026-10-13 cover commits that are not in the reference branch:

| Slice | Linear | Scope | Lands after |
| --- | --- | --- | --- |
| D27 | GRE-622 | Plate layout and STL geometry parity (#161) | D10 |
| D28 | GRE-623 | ZIP acquisition label policy and bundle-probe SQLite lifetime (#149) | D4 |
| D29 | GRE-624 | Failed-Save intent retry and draft lifecycle replay (#145, #148) | D13 |
| D30 | GRE-625 | Source catalog metadata through Rust HTTP (#144) | D8, D23 |
| D31 | GRE-626 | Reconcile CI ratchet commits from #155 with main | D1 |
| D32 | GRE-627 | Coverage audit mapping #133 and #135 patches to slices | none; runs early, re-checked before cutover |

Turning `desktop_rebuild` on by default is a separate decision for the maintainer after D26 and D32.
