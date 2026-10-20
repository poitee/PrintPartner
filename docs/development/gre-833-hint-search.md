# Preparation hint search

Preparation checks hint rules in shipped-then-custom order. Each rule searches
scanned paths in their existing order and stops at its first match, like Node's
`scannedPaths.some(...)` in `web/apps/server/src/services/path-hints.ts`.
Later rules still run, so group and variant merge precedence stays unchanged.
Each visited candidate checks the preparation cancellation flag. Matching also
charges the existing visit and comparison budgets. A refusal aborts preparation
before a draft is persisted.

The change is compiled only with the default-off `desktop_rebuild` feature.
Product callers retain the startup `DesktopRebuild` setting captured from
`PP_DESKTOP_REBUILD`. The storage client remains an internal boundary and does
not read the process environment or enable product routes.

The public-client tests use a disposable copy of `required-units/unchanged.db`
and synthetic filesystem observations. A test-only counter on the writer thread
counts iteration entries, including entries that the old fold skipped matching.
Two rules match the first of four paths; a missing rule visits all four.
The expected count is six, and the complete response matches the existing Node
`created-then-replayed` fixture, including its digest, with its timestamp normalized.
An explicit kit selection keeps the bracket hint selected, as in that fixture.
Cancellation is armed after hint loading and fires on the second search candidate.
Cancellation and visit-budget refusals preserve all five draft tables and source
file bytes. No elapsed-time assertion is used.

The focused run passes all three `preparation_hint` tests. Against the original
fold, the first-match test observes 12 iteration entries instead of six.
The runtime-gate module passes three tests in each feature mode, plus one ignored
child test that the environment test invokes in isolated subprocesses.

Run from the repository root with the VM's cargo wrapper and shared sccache:

```sh
umask 022
export CARGO_BUILD_JOBS=3
cargo test --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib preparation_hint
cargo clippy --manifest-path rust/Cargo.toml -p pp-storage --all-targets --no-default-features -- -D warnings
cargo clippy --manifest-path rust/Cargo.toml -p pp-storage --all-targets --features desktop_rebuild -- -D warnings
cargo test --manifest-path rust/Cargo.toml -p pp-storage --no-default-features --lib
cargo test --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib
cargo test --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --test working_draft_recompute --test working_draft_preparation_trim
```

The unchanged runtime gate can also be tested without a measured desktop bundle.
This compiles the actual gate module and runs its subprocess environment checks
in both feature modes:

```sh
gate_dir=$(mktemp -d)
printf '#[path = "%s/rust/crates/pp-core/src/rebuild.rs"] mod rebuild;\n' "$PWD" > "$gate_dir/gate.rs"
rustc --edition 2024 --test "$gate_dir/gate.rs" -o "$gate_dir/default"
"$gate_dir/default"
rustc --edition 2024 --cfg 'feature="desktop_rebuild"' --test "$gate_dir/gate.rs" -o "$gate_dir/enabled"
"$gate_dir/enabled"
```
