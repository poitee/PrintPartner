# Preparation hint search

Preparation checks hint rules in shipped-then-custom order. Each rule searches
scanned paths in their existing order and stops at its first match, like Node's
`scannedPaths.some(...)` in `web/apps/server/src/services/path-hints.ts`.
Later rules still run, so group and variant merge precedence stays unchanged.
Each visited candidate uses `path_matches`, whose existing visit and comparison
budget checks also observe cancellation. A refusal aborts preparation
before a draft is persisted.

The change is compiled only with the default-off `desktop_rebuild` feature.
Product callers retain the startup `DesktopRebuild` setting captured from
`PP_DESKTOP_REBUILD`. The storage client remains an internal boundary and does
not read the process environment or enable product routes.

The public-client tests use a disposable copy of `required-units/unchanged.db`
and synthetic filesystem observations. A test-only counter on the writer thread
counts iteration entries, including entries that the old fold skipped matching.
Two rules match the first of four paths; a missing rule visits all four.
The expected count is six. The complete response matches `preparation-hints-node.json`,
including its digest, with its timestamp normalized. The hints exclude the bracket;
removing the hints changes both inclusion and the digest. Existing manifest merge
tests cover group and variant precedence; this change leaves that merge untouched.
Cancellation and visit-budget refusal are armed after hint loading and fire on the
second search candidate. Both preserve all five draft tables and source file bytes.
Cancellation already worked on unmatched candidates in the original fold; that
test preserves existing behavior. The iteration counter proves the regression fix.
No elapsed-time assertion is used.

The focused run passes all three `preparation_hint` tests. Against the original
fold, the first-match test observes 12 iteration entries instead of six.
The runtime-gate module passes three tests in each feature mode, plus one ignored
child test that the environment test invokes in isolated subprocesses.

Run from the repository root with the VM's cargo wrapper and shared sccache.
The full unit suites also need the Node 22 fixture prerequisites from the
[Rust workspace setup](../../rust/README.md): `npm --prefix web ci`, then builds
of the `@print-partner/contracts` and `@print-partner/domain` workspaces.

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

Regenerate the hint response with Node 22 and the installed web dependencies:

```sh
node --conditions=development --import ./web/node_modules/tsx/dist/loader.mjs rust/crates/pp-storage/tests/fixtures/preparation-hints-node.mjs web/apps/server > rust/crates/pp-storage/tests/fixtures/preparation-hints-node.json
```
