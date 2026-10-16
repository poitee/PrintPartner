# GRE-644 slice 1 verification

Worktree `/persist/worktrees/laneD/gre-644`, branch
`gre-644-build-graph-kit-commands`, base
`5b598d3e44c1fd8fe52034bd73c826e723ea22fb`.
All verification commands used `umask 022`.
Tool versions: Rust 1.99.0, cargo-nextest 0.9.146, Node 24.21.0, npm 11.19.0.
Full local output is retained in `.audit/gre-644/` in this worktree.

## Setup and Node parity

```sh
cd web && npm ci
```

Exit 0. `added 719 packages, and audited 724 packages in 34s`;
`found 0 vulnerabilities`. npm warned about five packages whose install scripts
were not approved. No package approvals or lockfile changes were made.

```sh
cd web
npx tsx --conditions=development ../rust/crates/pp-storage/tests/fixtures/manifest-commands-node.mts apps/server > ../rust/crates/pp-storage/tests/fixtures/manifest-commands-node.json
```

Exit 0. Generated 1,495 bytes from Node's kit store and builder services.
The generator initially used the wrong repository creation signature and
`disconnect` method. It now uses the precedent's `createProfile(name, source)`
and `ports.db.close()`.

```sh
cd web
npx tsx --conditions=development ../rust/crates/pp-storage/tests/fixtures/manifest-commands-node.mts apps/server > ../.audit/gre-644/manifest-commands-regenerated.json
cmp ../rust/crates/pp-storage/tests/fixtures/manifest-commands-node.json ../.audit/gre-644/manifest-commands-regenerated.json
```

Both exit 0, no output. Regeneration is byte-identical.

## Failing-before evidence

```sh
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --test manifest_options_operations
```

Before implementation: exit 101. E0432 for missing `ManifestOptionsCommand` and
`ManifestOptionsOutcome`; E0599 for missing `build_graph_with_observations`,
`BuildCommand::Manifest` and `BuildOutcome::Manifest`.
After implementation, the initial focused run passed all six tests. A seventh
test and further assertions were added before the final full runs below.

```sh
python3 .audit/gre-644/check-save-mutant.py
```

Exit 0. The driver temporarily removed the kit and freshness writes from
`finish`, retaining its `Saved` result. It ran:

```sh
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --test manifest_options_operations -E 'test(read_builder_and_save_readback_match_node)'
```

Mutant exit 100. `1 test run: 0 passed, 1 failed, 6 skipped`.
The readback equality assertion failed: the actual kit was empty and the
expected kit had name `Saved`, selection `mini`, and include `part.stl`.
The driver restored the implementation in `finally` before final verification.

## Final verification

```sh
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild
```

```text
Summary [ 161.573s] 583 tests run: 583 passed, 1 skipped
```

```sh
cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-storage
```

```text
Summary [ 266.359s] 303 tests run: 303 passed (6 slow), 0 skipped
```

```sh
cargo clippy --locked --manifest-path rust/Cargo.toml -p pp-storage --all-targets --features desktop_rebuild -- -D warnings
```

```text
Checking pp-storage v0.1.0 (/persist/worktrees/laneD/gre-644/rust/crates/pp-storage)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 19.74s
```

```sh
cargo clippy --locked --manifest-path rust/Cargo.toml -p pp-storage --all-targets -- -D warnings
```

```text
Checking serde_json v1.0.145
    Checking pp-storage v0.1.0 (/persist/worktrees/laneD/gre-644/rust/crates/pp-storage)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 13.97s
```

```sh
cargo fmt --manifest-path rust/Cargo.toml --all --check
```

```text
Exit 0, no output.
```

All exited 0. The first full feature-enabled run also passed:

```text
Summary [ 161.389s] 583 tests run: 583 passed, 1 skipped
```

No GRE-640 timeout or isolated rerun occurred. Both legacy-password tests
passed in each feature-enabled run; the default-build variant also passed.

## Other checks

```sh
ast-grep test --config rust/sgconfig.yml --skip-snapshot-tests
python3 rust/scripts/test_ast_grep.py
python3 rust/scripts/check-ast-grep.py
```

Each exited 0. ast-grep: `2 passed; 0 failed`, covering 228 process-command
cases and 108 unwrap/expect cases. Python: `Ran 22 tests`, `OK`.
The production check reports:

```text
no-unwrap-expect: 45 hits (baseline 45)
runtime-process-command: 8 hits (baseline 8)
ast-grep ratchet passed: counts match the baseline.
```

The first production check found 47 unwrap/expect hits against baseline 45.
Both newly added `expect` calls were replaced with error propagation.
The first feature-enabled clippy run rejected the enlarged queue enum.
Boxing the prepared manifest fixed that failure without changing the scheduler.

```sh
python3 rust/scripts/check-boundaries.py --self-test
python3 rust/scripts/check-domain-deps.py --self-test
```

Both exited 0. Outputs:

```json
{"packages": 14, "allowed_edges": true, "intentional_violation_rejected": true}
{"pp_domain_tree_lines": 12, "forbidden_absent": true, "intentional_violation_rejected": true}
```

```sh
git diff --check
```

Exit 0, no output. The unslop pass reviewed the complete diff.
`manifest_options/observation.rs` and `pp-compat` are unchanged.

This is an implementation draft. Cross-vendor exact-head review and hosted CI
remain coordinator gates. GRE-644 still needs HTTP/runtime wiring with
D25/GRE-620, including `PP_DESKTOP_REBUILD` admission.
