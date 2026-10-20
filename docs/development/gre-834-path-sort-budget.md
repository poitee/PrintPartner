# Preparation path sorting

Draft preparation charges both path-key byte lengths to `comparison_work` before
each ICU comparison. This covers the scanned-part sort and the checkout paths
used to infer option groups. A comparison-budget refusal or cancellation returns
immediately, before the next ICU call or draft write.

Both sites use a stable merge sort of indices, then apply the resulting
permutation to the original values. Equal keys keep their encounter order.
The sort uses two buffers of indices and does not clone parts during merging.
Empty and single-path sorts return without budget checks, preserving the caller's
existing empty-scan cancellation handling.
Checkout paths cache their lowercase keys once instead of allocating keys inside
every comparison. The existing inventory entry and path limits still apply.

The code remains inside the default-off `desktop_rebuild` module. Product callers
also require the startup `DesktopRebuild` value captured from `PP_DESKTOP_REBUILD`.
The internal storage client does not activate that product gate.

The public-client tests call `WriterOwner`'s working-draft client with a disposable
database and synthetic observations. The complete successful recompute response,
including part order and snapshot digest, matches the Node 22 fixture after
normalizing its timestamp. Paths cover punctuation, numeric names, accents, and
a soft hyphen that ICU ignores. Equal keys retain their encounter order.
Test-only probes isolate each sort, admit one comparison, and refuse or cancel
before the next ICU call. Refusals preserve all five draft tables and source-file
bytes.

The focused path-sort run passes three tests, and the existing hint run passes
three tests. Removing only the comparison charge makes both sort refusal tests
fail: they observe 22 ICU calls after admitting one. The Node response still
matches in that mutation. The unchanged runtime gate module passes three tests
in each feature mode, plus one ignored child test invoked by its subprocess test.

Use the fleet Cargo semaphore wrapper with three build jobs and shared sccache.
Install the Node 22 fixture prerequisites as described in the
[preparation hint search checks](gre-833-hint-search.md).

```sh
export CARGO_BUILD_JOBS=3
export RUSTC_WRAPPER=/opt/agent-fleet/bin/sccache
cargo test --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib preparation_path_sort
cargo clippy --manifest-path rust/Cargo.toml -p pp-storage --all-targets --no-default-features -- -D warnings
cargo clippy --manifest-path rust/Cargo.toml -p pp-storage --all-targets --features desktop_rebuild -- -D warnings
cargo test --manifest-path rust/Cargo.toml -p pp-storage --no-default-features --lib
cargo test --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --lib
cargo test --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --test working_draft_recompute --test working_draft_preparation_trim
```

Regenerate the exact response with Node 22 and installed web dependencies:

```sh
node --conditions=development --import ./web/node_modules/tsx/dist/loader.mjs rust/crates/pp-storage/tests/fixtures/preparation-path-sort-node.mjs web/apps/server > rust/crates/pp-storage/tests/fixtures/preparation-path-sort-node.json
```
