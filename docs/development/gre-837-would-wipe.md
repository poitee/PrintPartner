# Preparation would_wipe outcome

Preparation drops captured rows whose key does not end in `.stl` before the
`no_stls` and `would_wipe` checks, the same cut Node's `scanRepo` makes while
walking the tree. A scan whose remaining rows are empty is `no_stls`, including
when the accepted Plan has parts and when it has none. That refusal returns
before preparation writes a draft.

`would_wipe` stays the outcome for a merge that leaves no parts while accepted
parts still exist. The public recompute and rebase clients serialize it as
`{"kind":"would_wipe"}`, the same shape Node uses for `no_layers` and `no_stls`.
A scanner full of non-`.stl` names does not reach it.

The code remains inside the default-off `desktop_rebuild` module. Product
callers still require the startup `DesktopRebuild` value captured from
`PP_DESKTOP_REBUILD`. This slice does not mount a route or read that variable.
`docs/desktop-rebuild.md` still says the outcome has no Rust counterpart; open
PR #1003 owns that file, so this note is the updated description.

The public-client tests call `WriterOwner`'s working-draft client with a
disposable copy of `required-units/unchanged.db`:

- `would_wipe_serializes_without_a_scanner` builds `RecomputeOutcome::WouldWipe`
  and `RebaseOutcome::WouldWipe` and checks each body is
  `{"kind":"would_wipe"}`.
- `non_stl_scans_are_no_stls` reports one `captured-input.txt` row. With the
  fixture's accepted parts, and with a second Plan that has layers and no
  accepted parts, the body is `{"kind":"no_stls"}` and the draft tables stay
  unchanged.
- `valid_scans_do_not_report_would_wipe` reports `notes.txt` and `kept.stl`.
  The created draft's only part key and relative path are `kept.stl`. It also
  replays the existing hint scan and matches `preparation-hints-node.json`.

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
