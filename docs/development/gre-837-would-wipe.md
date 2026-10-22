# Preparation would_wipe outcome

Preparation returns `would_wipe` when captured scan rows leave no parts and the
accepted Plan still has parts. The public recompute and rebase clients serialize
that outcome as `{"kind":"would_wipe"}`, the same shape Node's preparation
result uses for `no_layers` and `no_stls`.

The nonempty scan guard stays where it is. A scanner that returns no rows is
still `no_stls`, including when accepted parts exist. A valid scanner emits only
`.stl` keys, and those keys still merge into the current prepared draft. A
captured row whose key does not end in `.stl` can pass the guard and still
leave no parts. That is the `would_wipe` refusal. It returns before preparation
writes a draft.

The code remains inside the default-off `desktop_rebuild` module. Product
callers still require the startup `DesktopRebuild` value captured from
`PP_DESKTOP_REBUILD`. This slice does not mount a route or read that variable.
`docs/desktop-rebuild.md` still says the outcome has no Rust counterpart; open
PR #1003 owns that file, so this note is the updated description.

The public-client tests call `WriterOwner`'s working-draft client with a
disposable copy of `required-units/unchanged.db`:

- `preparation_would_wipe_matches_node_contract` reports one captured
  `captured-input.txt` row. The body is exactly `{"kind":"would_wipe"}`. Draft
  tables, accepted revision parts, the `parts` table, and both on-disk files
  stay unchanged.
- `valid_scans_do_not_report_would_wipe` reports no rows and keeps
  `{"kind":"no_stls"}` with the same rows and the sentinel file. It also replays
  the existing hint scan and matches `preparation-hints-node.json`.

Run from the repository root with the VM cargo wrapper and shared sccache:

```sh
umask 022
export CARGO_BUILD_JOBS=3
export CARGO_TARGET_DIR=/persist/targets/gre-837-would-wipe-outcome
cargo test --manifest-path rust/Cargo.toml --locked -p pp-storage --features desktop_rebuild --lib preparation_
cargo test --manifest-path rust/Cargo.toml --locked -p pp-storage --features desktop_rebuild --test working_draft_recompute a_profile_without_
cargo clippy --manifest-path rust/Cargo.toml --locked -p pp-storage --all-targets --features desktop_rebuild -- -D warnings
cargo clippy --manifest-path rust/Cargo.toml --locked -p pp-storage --lib --no-default-features -- -D warnings
cargo test --manifest-path rust/Cargo.toml --locked -p pp-storage --lib --no-default-features
```
