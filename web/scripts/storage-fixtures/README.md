# Storage fixtures

`prepare.mts` builds disposable SQLite inputs for the pp-storage generated-fixture check.

This is a generated-fixture contract. The script does not copy a historical schema 31, 32, 33, or 34 database, and it does not replay migration order.

## What the script builds

For `schema-31`, `schema-32`, `schema-33`, `schema-34`, and `immutable-corpus`, Node `SqliteDatabase.connect` creates a current schema 34 database. The script then runs the `transformations` listed on that case. `fresh` starts from an empty directory. The expected database for every case is a later Node connect plus the settings sequence.

`schema-32` and `schema-33` use one shape group, `generated-v34-minus-board-tables`. Their `schema_version` stamps differ. After Node connect, both expected trees are the current schema 34 graph. Equal endpoint bytes are that convergence. They are not a migration-order result.

The Rust test name `ticket_t_7_migrations` is the selector target for this generated-fixture check. Passing it does not close GRE-400.

## Metadata

`fixtures.json` records these fields.

- `contract` is `generated-fixture-compatibility`.
- `kind` is `generated-current-node` on every case.
- `historicalSnapshot` is false on the file and on every case. A `kind` of `historical-snapshot` is refused before open.
- `sourceSchemaVersion` is the Node `currentSchemaVersion` that connect built. This generator requires 34.
- `startingVersionStamp` is the integer written into `app_settings.schema_version` on the Rust input. `fresh` uses 0 because that input directory is empty.
- `shapeGroup` names the manual edit group.
- `transformations` lists those edits in apply order.
- `node`, `abi`, and `nodeSha256` identify the Node binary that wrote the files.
- `generatorSha256` is the hash of `prepare.mts`.
- `cacheKey` is the hash of the generator hash, Node identity, clock, and each case name, kind, historical flag, shape group, stamp, and transformations.
- `rustFiles` and `expectedFiles` are the output file hashes. A stale file does not match these hashes.

## What this does not prove

Copied historical databases, the migration step order between schema 32 and schema 33, AppStartupReady, and route-worker cutover are outside this contract.
