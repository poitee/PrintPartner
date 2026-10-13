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
