# GRE-918 stored naming refusals

The capture covers 31 named corrupt overrides. The table includes unknown
top-level fields and fields inside roles, quantity, slug, and folder rules;
duplicate roles; an invalid role ID; raw JSON type errors; blank fields;
invalid and multi-group quantity regexes; out-of-range quantity defaults; an
invalid functional class; short and duplicate export role orders; and five
mixed defects that record which error wins.

The [generator](../../rust/crates/pp-storage/tests/fixtures/gre918-stored-naming-node.mjs)
calls the public Node repository methods `getSourceNaming` and
`recomputePlanDraft`. The [JSONL capture](../../rust/crates/pp-storage/tests/fixtures/gre918-stored-naming-node.jsonl)
retains each raw override, the entire Node catalog result, the exact preparation
error, and separate literal Rust expectations for both feature modes.

Node 22.23.3 executed all 31 cases successfully during implementation.
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
The feature-off catalog test executes all 31 cases.

With `desktop_rebuild` on, Rust's shared stored-override validator in
`catalog/naming.rs` reports the first issue Node's
`StlNamingProfileOverrideSchema` reports. It checks fields in schema order
(`roles`, `quantity`, `slug`, `folder_rules`, `export_role_order`). Inside each
object it checks fields in schema order, then unknown keys. Inside each array
it checks elements, then length, then uniqueness. Messages use zod 4.6.7's
literal text. For example, `mixed-quantity-type-blank-folder` now fails with
`override.quantity.default: Invalid input: expected number, received string`
before the blank folder rule, as Node does.

Both public clients verify all 31 literal expectations with the feature on:
catalog `GetNaming` and preparation `recompute`. All 31 feature-on details
match Node, so `known_mismatch.feature_on` is `false` for every case. Before
this fix, 16 of the original 21 differed. Feature-on catalog failures retain
the outer text `Stored Source naming settings are invalid` and
`CatalogFailure::InvalidStoredNaming`, with Node's detail as the root cause.

Feature-off behavior is unchanged. All 31 feature-off details still differ
from Node and stay marked `known_mismatch.feature_off: true`.

Rust keeps its existing quantity regex length and group-complexity limits.
A pattern that exceeds them fails with `is an invalid regular expression`,
which Node would accept. This was already a refusal before this change.

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

Both runs pass with nonzero tests, as does the existing `stored_naming_refusals`
target in both modes. Node regeneration matches byte for byte. Feature-off
behavior and stored `PP_DESKTOP_REBUILD` admission do not change.
