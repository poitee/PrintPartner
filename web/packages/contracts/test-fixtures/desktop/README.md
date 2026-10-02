# Node autosave contract fixture

`autosave-v1.json` captures the current Node authority. It contains 41 input/output parser cases and 18 actual save/review route cases with raw responses, parsed receipts/reviews and complete recorded database/file states. It is a migration prerequisite, not proof of Rust or native parity.

From `web/`, after installing dependencies and rebuilding `better-sqlite3` for the active Node runtime:

```sh
node --conditions=development --import tsx scripts/desktop-parity/verify.mts
```

The verifier creates two fresh temporary SQLite captures, compares them against each other and this golden, and runs comparator drift tests. It cleans up its own data. One save binds a real localhost HTTP server. All Sources are local STL fixtures; no real printer or integration is contacted. The temporary Node authority runtime is Node 24.21.0.

For individual captures and comparisons:

```sh
node --conditions=development --import tsx scripts/desktop-parity/capture.mts /tmp/capture.json
node --conditions=development --import tsx scripts/desktop-parity/compare.mts packages/contracts/test-fixtures/desktop/autosave-v1.json /tmp/capture.json
npx tsc -p scripts/desktop-parity/tsconfig.json --noEmit
npx eslint scripts/desktop-parity/
```

The `format` field versions the corpus. `schema_cases` name the actual exported parser, input/output direction, exact input and accepted parsed result or rejected Zod issues. Strict fields, discriminator branches, base/draft custom refinements, no number coercion, quantity 1..10000 bounds, duplicate fields and omitted versus nullable values are represented explicitly. Runtime Zod refinements are authority; a generated JSON Schema alone cannot replace these cases.

`route_cases` contain operation, transport, profile, input, headers, expected HTTP status, raw response, parsed response, before/after state IDs and checked invariants. `states` contain source, Plan publication, draft, reconciliation, Required-unit, progress, durable receipt, Plate and setting rows plus file hashes. `setup_operations` retain actual accepted Plate commands and their results.

`table_ordering` declares all primary-key columns in SQLite `PRAGMA table_info` primary-key ordinal order for each table. Tables without a primary key use all declared columns in column-ID order. Queries sort ascending by that complete sequence. The four-column Required-unit mapping/assignment keys exercise ties in their first two columns. Tests require unique complete keys and exact canonical ordering in every state. Array order remains part of comparison. State IDs are SHA256s of normalized JSON with object keys recursively sorted, so JSON object insertion order cannot change snapshot identity.

The raw capture retains the original temporary directory. Normalization replaces only that declared prefix with `$DATA`. Fixture time, file mtime and Required-unit entropy are controlled before the operation runs, so timestamps, IDs, unit tokens, object names, hashes and domain digests stay exact. The comparator first verifies raw/normalized consistency. It never removes nulls, invents omitted fields or replaces identities or digests. A future Rust runner should consume these inputs and retained identity/receipt rows, emit the versioned evidence shape, and compare it through the same tool.

Replay after a newer accepted publication returns the original receipt and current accepted review. The observed user draft becomes abandoned on success while the command-owned draft becomes consumed. A fixture exception immediately after actual native publication proves the outer transaction restores prior accepted history and the open user draft. Active Checkoff work and an unsafe remap use the existing repository policy. SQLite is closed and reopened before persisted review and replay.

Two real accepted Plate publications are seeded through the existing repository API, first on the original accepted Plan and again before replay/conflict/rollback. Historical Plate revision, plate and unit rows retain their Plan revision, digest, mapping digest, Plate identity and Required-unit tokens exactly through later publications, failures and reopen. Successful Plan publication intentionally removes the current Plate head; unchanged and rolled-back operations preserve the prior head exactly. Historical identity/linkage drift is rejected by comparator tests. This fixture does not change Node's head invalidation policy or send to its synthetic printer metadata. Auth, browser/native transport, live Spoolman, printer effects, maximum-size route publication, rollback on real disk failure and Rust DTO generation remain separate checks.

Refresh a golden only after reviewing an intentional authority change. Changing the golden to make a failing comparison pass discards the parity evidence.
