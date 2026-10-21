# Stored naming refusal parity

`preparation-naming-node.jsonl` records Node 22.23.3 results from the current
self-host repository client. Each case uses a disposable copy of `unchanged.db`.
The generator checks every table and an STL file after each refusal. The stale
accepted-pointer case disables the fixture connection's foreign keys and drops
its pointer-ownership trigger to represent corrupt stored data.

Regenerate from the repository root after installing `web` dependencies:

```sh
cd web
node --conditions=development --import tsx ../rust/crates/pp-storage/tests/fixtures/preparation-naming-node.mjs apps/server > /tmp/preparation-naming-node.jsonl
diff -u ../rust/crates/pp-storage/tests/fixtures/preparation-naming-node.jsonl /tmp/preparation-naming-node.jsonl
```

Run the Rust public-client checks in both modes:

```sh
cargo test --manifest-path rust/Cargo.toml -p pp-storage --test stored_naming_refusals
cargo test --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --test stored_naming_refusals
```

The default mode retains its existing null acceptance. With `desktop_rebuild`,
stored Source overrides reject explicit null classes and retain override indices
for blank role labels, quantity patterns, and folder paths. Missing classes and
both valid classes remain readable. Catalog errors retain `InvalidStoredNaming`;
preparation exposes the nested field detail and Node's stale accepted-base text.
Product callers still enforce stored `PP_DESKTOP_REBUILD`; these changes neither
expose a new endpoint nor change feature admission. No flag is activated here.
