# Catalog metadata mutation parity

`node.json` records actual Node Fastify responses and database rows. The Rust
integration test replays its public serde requests through `SourceCatalogClient`
and compares the entire outcome and persistent snapshot after every command.
All data lives in disposable temporary SQLite databases and local directories.
The generator initializes its database through the existing `storage-fixture`
binary and `WriterOwner`, using the fleet Cargo wrapper. Node's real repository
then connects directly through Drizzle. This preserves Rust's current schema,
including `source_configuration_version`, in every raw project snapshot.

The 26-command transcript covers:

- Category creation, ordered tree responses, assignment with duplicate selectors,
  ancestor rename with descendant moves, child deletion with ancestor fallback,
  explicit uncategorisation, and assignment clearing.
- Full naming-profile saves changing only `quantity.default`,
  `slug.strip_markers`, and `slug.strip_quantity`, followed by `UseDefaults`.
- Two database reopens, with public reads of naming, categories, complete Source
  summaries, and activity. The first reopen retains the nondefault override;
  the second retains the clear and the successful Source deletion.
- Foreign-tenant assignment and naming set/clear attempts, a successful read of
  that tenant's own Source, and category/naming edits of a deleted Source ID.
  These attempts preserve all selected stored state.

The fixture seeds three local Sources, nonempty unrelated nested metadata,
per-tenant category and global naming settings, unrelated setting sentinels, and
two activity sentinels. The fixed foreign session is a disposable fixture
credential stored as a SHA-256 digest. Node uses tenant-bound real repositories;
Rust resolves that credential through the public session catalog client.

`generate.mjs` registers the existing settings, naming, and Source routes on
isolated Fastify instances and uses `inject`; it never starts a listener or
copies production mutation logic. The Rust adapter only supplies existing HTTP
envelopes: 200 for successful values, `{events}` for activity, 204 with an empty
body for a successful deletion, and the existing 404 naming error contract for
typed `CatalogFailure::NotFound`. Its detail comes from the actual Rust error.
Bulk per-item errors remain untouched.

Snapshots select every column of every `projects` and `app_events` row, and every
column of `app_settings` rows with keys `source_categories`,
`stl_naming_defaults`, or `catalog_metadata_sentinel`, across both tenants.
JSON-valued metadata, settings, and activity payloads are parsed before literal
JSON comparison; no semantic fields are discarded. Other raw columns, including
`imported_paths`, are retained verbatim. Only temporary `local_path` prefixes
become `@DATA_DIR@`, after validating the exact expected path and its existence.
All timestamps are fixed fixture values and compared verbatim. No timestamps
are removed or replaced. Each complete snapshot is embedded on one JSON line.

Neither client has a version token. "Deleted Source ID" means an ID that was
successfully deleted earlier in this transcript; it does not test rejection of
a stale metadata snapshot. Invalid category paths with different error wording,
concurrent naming conflicts, and explicit-null `functional_class` from GRE-832
are outside this successful mutation slice. No production code is changed.

From the repository root, use Node 22 with the workspace dependencies and
better-sqlite3 native module installed. On fleet VMs, keep the existing Cargo
semaphore wrapper on PATH and the shared sccache environment configured.

```sh
node fixtures/parity/catalog-metadata-mutations/generate.mjs
node fixtures/parity/catalog-metadata-mutations/generate.mjs --check
cd rust
CARGO_BUILD_JOBS=3 cargo test --locked -p pp-storage --features desktop_rebuild --test catalog_metadata_parity
```

The test is gated by `desktop_rebuild` and requires no module registration.
