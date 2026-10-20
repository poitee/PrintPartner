# GRE-918 stored naming refusals

The capture covers 54 named corrupt overrides. The table includes unknown
top-level fields and fields inside roles, quantity, slug, and folder rules;
duplicate roles; an invalid role ID; raw JSON type errors; blank fields;
invalid and multi-group quantity regexes; out-of-range quantity defaults; an
invalid functional class; short and duplicate export role orders; unknown
keys that need JavaScript key order and literal quoting; well-formed and
unbalanced regexes over Rust's group limit; regex syntax Node 22 rejects;
escaped capture names; and mixed defects that record which error wins.

The [generator](../../rust/crates/pp-storage/tests/fixtures/gre918-stored-naming-node.mjs)
calls the public Node repository methods `getSourceNaming` and
`recomputePlanDraft`. The [JSONL capture](../../rust/crates/pp-storage/tests/fixtures/gre918-stored-naming-node.jsonl)
retains each raw override, the entire Node catalog result, the exact preparation
error, and separate literal Rust expectations for both feature modes.

Node 22.23.3 executed all 54 cases successfully during implementation.
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
The feature-off catalog test executes all 54 cases. A case with
`override_json` stores that exact text, so integer-like keys keep an order a
JavaScript object would normalize.

With `desktop_rebuild` on, Rust's shared stored-override validator in
`catalog/naming.rs` reports the first issue Node's
`StlNamingProfileOverrideSchema` reports. It checks fields in schema order
(`roles`, `quantity`, `slug`, `folder_rules`, `export_role_order`). Inside each
object it checks fields in schema order, then unknown keys. Inside each array
it checks elements, then length, then uniqueness, except that an array over its
upper size bound fails before its elements. Unknown keys are listed in
JavaScript order, with array-index keys first in ascending order, and wrapped
in quotes without escaping. Messages use zod 4.6.7's literal text. For example, `mixed-quantity-type-blank-folder` now fails with
`override.quantity.default: Invalid input: expected number, received string`
before the blank folder rule, as Node does.

Both public clients verify all 54 literal expectations with the feature on:
catalog `GetNaming` and preparation `recompute`. 53 feature-on details match
Node. `regex-over-group-limit` is the one recorded difference. Before
this fix, 16 of the original 21 differed. Feature-on catalog failures retain
the outer text `Stored Source naming settings are invalid` and
`CatalogFailure::InvalidStoredNaming`, with Node's detail as the root cause.

Feature-off behavior is unchanged. All 54 feature-off details still differ
from Node and stay marked `known_mismatch.feature_off: true`.

Rust keeps its existing quantity regex length and group-complexity limits.
When the rest of the override validates, an otherwise balanced pattern that
exceeds them fails with the limit's own message, such as
`override.quantity.regex: Quantity regex exceeds group complexity limits`.
Node compiles such a pattern and applies its normal checks. This was already
a refusal before this change. Rust defers the limit refusal until after all
schema checks in Node order, including quantity defaults, later fields, and
unknown keys. Unbalanced groups and classes report Node's
`is an invalid regular expression`, even past a limit. A pattern past a limit
with any other syntax error skips compilation, so Rust can report a later
schema error or the limit message instead of Node's syntax error.

Rust compiles quantity regexes with `regress`, which accepts two ES2025 forms
that Node 22's V8 rejects: group modifiers such as `(?i:(a))` and group names
repeated across alternatives such as `(?<x>a)|(?<x>b)`. With the feature on,
every quantity regex check refuses both. That covers saves, global defaults,
and stored overrides. A refused save reports `Invalid quantity regex`, and a
stored override reports Node's `is an invalid regular expression`. With the
feature off, both forms are still accepted. Other differences between
`regress` and V8 syntax are not covered here.

The duplicate-name check compares decoded `\uXXXX` and `\u{...}` escapes,
including surrogate pairs and astral characters. A `\x` escape is invalid in
a capture name. The capture checks both duplicate and distinct escaped names;
save tests verify valid escaped names remain accepted in both modes.

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
