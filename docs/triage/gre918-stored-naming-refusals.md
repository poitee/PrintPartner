# GRE-918 stored naming refusal capture

This test-only capture covers 21 named corrupt overrides. The table includes
unknown top-level fields and fields inside roles, quantity, slug, and folder
rules; duplicate roles; an invalid role ID; raw JSON type errors; blank fields;
and four mixed defects that record which error wins.

The [generator](../../rust/crates/pp-storage/tests/fixtures/gre918-stored-naming-node.mjs)
calls the public Node repository methods `getSourceNaming` and
`recomputePlanDraft`. The [JSONL capture](../../rust/crates/pp-storage/tests/fixtures/gre918-stored-naming-node.jsonl)
retains each raw override, the entire Node catalog result, the exact preparation
error, and separate literal Rust expectations for both feature modes.

Node 22.23.3 executed all 21 cases successfully during implementation.
Every catalog result was exactly `{"kind":"invalid_state"}`. This public method
returns no detail field. The preparation error supplies Node's field detail;
the capture never invents a catalog detail or converts a Rust error into one.

Each runtime uses a disposable `required-units/unchanged.db` copy, an STL file,
a manifest, and a catalog document. Before a public call, the checks snapshot all
rows in every table and the bytes and paths of every non-database fixture file.
They compare that snapshot immediately after each call. SQLite database, WAL,
and SHM bytes are excluded because rows represent the database state.
Rust preparation injects `Unread` through the public observation client.
Every STL, manifest, or catalog observation panics, so a refusal must occur
before file observation. Preparation remains gated by `desktop_rebuild`.
The feature-off catalog test executes all 21 cases.

Rust's public catalog client verified all 21 literal expectations in both
feature modes. Its public preparation client verified all 21 with the feature
on. The following are demonstrated differences:

- `unknown-top`: Node `override: Unrecognized key: "surprise"`;
  Rust in both modes `Unknown naming field`.
- `duplicate-roles`: Node `override.roles: role ids must be unique`;
  Rust in both modes `Duplicate role override`.
- `raw-quantity-string`: Node
  `override.quantity.default: Invalid input: expected number, received string`;
  Rust in both modes `invalid type: string "2", expected u64`.
- `mixed-invalid-role-blank-regex`: Node
  `override.roles.0.id: Invalid option: expected one of "primary"|"accent"|"clear"|"opaque"`;
  Rust feature-off ``unknown variant `future`, expected one of `primary`, `accent`, `clear`, `opaque` ``;
  Rust feature-on `override.quantity.regex: must not be blank`.
- `mixed-quantity-type-blank-folder`: Node
  `override.quantity.default: Invalid input: expected number, received string`;
  Rust feature-off `invalid type: string "2", expected u64`;
  Rust feature-on `override.folder_rules.0.path_contains: must not be blank`.

The JSONL records every exact expected detail, including unknown nested fields
and serde type messages. `known_mismatch` explicitly marks the expected detail
differences: 21 with the feature off, 16 with it on. Feature-on catalog failures
also retain the exact outer text `Stored Source naming settings are invalid`
and `CatalogFailure::InvalidStoredNaming`; preparation exposes the nested detail.
These differences remain deferred production work. Matching refusal categories
do not establish detail parity, and this capture does not change production.

Regenerate with Node 22 on `PATH` and installed `web` dependencies:

```sh
cd web
node --conditions=development --import tsx ../rust/crates/pp-storage/tests/fixtures/gre918-stored-naming-node.mjs apps/server > /tmp/gre918-node.jsonl
diff -u ../rust/crates/pp-storage/tests/fixtures/gre918-stored-naming-node.jsonl /tmp/gre918-node.jsonl
```

Run from the repository root through the fleet's existing two-slot Cargo
wrapper, with `CARGO_BUILD_JOBS=3`, shared sccache, and a private target:

```sh
cargo test --manifest-path rust/Cargo.toml -p pp-storage --test gre918_stored_naming
cargo test --manifest-path rust/Cargo.toml -p pp-storage --features desktop_rebuild --test gre918_stored_naming
```

Both runs passed with nonzero tests, as did the existing `stored_naming_refusals`
target in both modes. Node regeneration matched byte for byte. No runtime
behavior or stored `PP_DESKTOP_REBUILD` admission changes here.
