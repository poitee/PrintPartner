# Parity fixtures

Golden data captured from the TypeScript app, used as the reference for the Rust port.

## Parity runner (GRE-451, T-10-fixtures)

`pp_api::fixtures`, behind the default-off `desktop_rebuild` feature, replays copied fixtures against Rust routers on disposable data directories with no OAuth provider and no mailer. `Ledger` requires each Rust response to equal Node's status, complete JSON body and literal `Set-Cookie` headers, unless the case has a declared `Correction`. A correction names its kind (security, WebSocket, or durable-store) and reason, and holds the literal Rust response. It fails if Rust now matches Node, if it is never used, or if it is declared twice. `StateGraph` records every row of every SQLite table and the SHA-256 of every other file, so a test can compare state changes as well as responses.

`rust/crates/pp-api/tests/ticket_t_10_fixtures.rs` runs `auth-login` (11 exact, 3 security corrections, no state change on any refusal) and `auth-session` (4 exact, 3 clearing-cookie corrections, Node's session row count, and only the `sessions` table changing when that count moves). It also runs `jobs-http`, `jobs-ws`, `plans-http`, `drafts-http`, `layers-http`, `manifest-http` and `catalog-http` (see below). Run it with `cargo nextest run --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --no-tests=fail -E 'test(ticket_t_10_fixtures)'`.

## jobs-http/node.json (GRE-451)

`generate.mjs` registers Node's real job read routes, flat and under `/api/v1`, over an `InProcessJobRunner` that has finished an update check and, a second later, failed a checklist export for profile 7. It records 13 complete responses: the `/api/v1/jobs` list under each filter, both jobs on both read-one aliases, and an unknown id on both aliases. Job ids and timestamps become labels numbered in first-seen order (`job-1`, `time-1`); `pp_api::fixtures::Labels` labels the Rust responses the same way. `updated_at` gets its own `updated-N` labels, because Node stamps it with a second clock read after `finished_at` and their equality depends on a millisecond tick.

`ticket_t_10_fixtures` replays the cases against `jobs_router`, with 5 exact matches and 8 declared durable-store corrections: Rust snapshots add `created_at`, and a failed durable job reports "Job failed" and its last progress instead of the handler's in-memory error (both documented for GRE-609 in `docs/desktop-rebuild.md`). The reads change no table or file. Node's read-one returns the stored snapshot without `updated_at`, which only its list adds; Rust's read-one now does the same.

```sh
node fixtures/parity/jobs-http/generate.mjs --check
```

## jobs-ws/node.json (GRE-451)

`generate.mjs` registers Node's real job socket (`registerJobWebSocket`, with `PP_DESKTOP_REBUILD=1`) over the same two retained jobs as `jobs-http`, listens on loopback and opens `/ws/jobs/:jobId` with a `ws` client. Each case records every text frame plus the close code and reason the client saw. The five cases are the finished job, the failed job, an unknown id, the finished job read by another tenant, and a live job (`ws_live`). Node mounts the socket only at the root, so there is no `/api/v1` case.

Two parts of the probe are stubs, not Node's app:

- The probe mounts no auth. Node's app sets `request.tenantId` from the session; here an `x-parity-tenant` header sets it. The runner's own owner check still decides who reads a job, so the foreign case exercises Node's tenant refusal but not its session lookup.
- `ws_live` follows a third update check. The probe replaces `runner.runJob` so the job stays queued, then sends the two patches `runJob` emits (running at 10%, then done) through the runner's own `emit`, one after each frame. Node's handlers have nothing a probe can hold open without network access.

A socket that has not closed within 10 seconds fails the capture. Node stamps `updated_at` with its own clock read, so it gets `updated-N` labels, and the probe spaces the live steps 5 ms apart so each frame's stamp is distinct.

`ticket_t_10_fixtures` opens the same paths on `jobs_router` with the owning session, or a second account's session for the other tenant. It reads frames off the raw socket, joins fragmented text, skips ping and pong frames, and fails if a socket stays open for 10 seconds. For `ws_live`, the seeded worker claims the job after the first frame and finishes it after the second. The results are 2 exact matches and 3 declared WebSocket corrections:

- An unknown or foreign job matches exactly. Each gets no frame, then 1008 "Job not found".
- For the finished and failed jobs, Node ends the stream with `socket.close()`, an empty close frame the client reads as 1005, and Rust sends 1000. Rust's frame is the durable snapshot that `jobs-http` corrects (`created_at`, and "Job failed" with no progress).
- In `ws_live`, Rust streams the durable model's wording, as `docs/desktop-rebuild.md` and `jobs_engine_parity` record. The queued frame says "Waiting for a compatible worker" instead of "Queued", and the running frame says "Running" with no progress instead of "Running…" at 10. Every frame carries `created_at` and `finished_at`, and none carries `updated_at`, which Node adds only to live frames. The stream closes 1000.

No socket changes a table or file. The test checks this just before the live case. After that, only the worker writes.

```sh
node fixtures/parity/jobs-ws/generate.mjs --check
```

CI runs every GRE-451 generator with `--check` in the Desktop contracts workflow ("Verify GRE-451 parity Node fixtures"), and `scripts/local-ci.py` runs the same commands. PR CI skips the `desktop_rebuild` nextest on self-hosted Linux, so the same workflow also replays the goldens against Rust on the Node 22 leg ("Replay GRE-451 parity fixtures against Rust"):

```sh
cargo test --locked --manifest-path rust/Cargo.toml -p pp-api --features desktop_rebuild --test ticket_t_10_fixtures
```

## plans-http/node.json (GRE-451)

`generate.mjs` builds Node's real app (`buildApp` over self-host ports, no API key) on a scratch data directory and sends 28 requests in order to the Plan routes Rust's `build_router` serves: create, list, read-one, layers, touch and delete, each on the flat, `/api/v1` and `/api/v2` mounts, plus duplicate, blank, unnamed and unknown-id refusals. Each case records the complete response and the database tables it changed. Plan ids are sequential on a fresh database and stay literal; timestamps become `time-N` labels.

`ticket_t_10_fixtures` replays the cases in order against `build_router` with a session cookie and compares each response and each case's changed tables, with 27 exact matches and 1 declared durable-store correction. Node's `POST /plans` inserts the Plan before it looks up `base_project_id`, so a refused create leaves a Plan behind. Rust refuses before it writes: that case changes no table in Rust, and the list after it does not show the leftover Plan. The fixture made two Rust fixes go red then green. `/api/v1` now answers with Node's legacy summary (`remaining_units` and `total_units` instead of `accepted_progress`, with Node's 409 and 500 refusals when accepted progress is unavailable). A create body with no `name`, or a null one, now gets "Profile name is required".

```sh
node fixtures/parity/plans-http/generate.mjs --check
```

## drafts-http/node.json (GRE-451)

`generate.mjs` builds Node's real app on a copy of `rust/crates/pp-storage/tests/fixtures/required-units/unchanged.db`, where Plan 1 has consumed draft 1 and open draft 2 and Plan 2 belongs to another tenant. It sends 30 requests in order to the draft routes Rust's `draft_router` serves, on the flat and `/api/v2` mounts: list, workspace read, part edit (including a replayed edit), abandon, and their invalid-id, invalid-body, missing, foreign-tenant, stale and not-open refusals. Each case records the complete response and the tables it changed. No response carries a clock value, so nothing is labelled.

`ticket_t_10_fixtures` replays the cases against `draft_router` on its own copy of the same database, with that database's session cookie: 30 exact matches, no corrections, and the same changed tables for every case.

```sh
node fixtures/parity/drafts-http/generate.mjs --check
```

## layers-http/node.json (GRE-451)

`generate.mjs` uses the same copied database after its `seed` SQL adds three Sources with no files (two for tenant `default`, one for `foreign`). It sends 33 requests in order to the Plan layer mutations Rust's `build_router` serves, on the flat, `/api/v1` and `/api/v2` mounts: attach an add-on, replace it, set the base, detach, and their duplicate, missing, foreign and no-Source refusals. Two cases send `project_id` as `2.0` and `1e0`; their bodies are recorded verbatim as `rawBody`, because `JSON.stringify` would write them as integers. Each case records the complete response and the tables it changed.

`ticket_t_10_fixtures` runs the same seed on its copy and replays the cases against `build_router`: 33 exact matches, no corrections, and the same changed tables for every case. The fixture made one Rust fix go red then green. Node reads `project_id` with `Number()`, so a body with no usable id (missing, `null`, `0`) passes Node's Plan check and then finds no Source: 404 "Project not found" (or "Layer not found" for a replace of a layer the Plan does not have). Rust refused such a body with 400 "Request is invalid"; it now gives Node's answers and writes nothing. A body that is not a JSON object is still a 400. A second fix also went red then green: Rust read `project_id` only as an integer, so `2.0` found no Source, while Node's `Number()` reads it as 2. Rust now accepts any whole-number JSON value.

```sh
node fixtures/parity/layers-http/generate.mjs --check
```

## manifest-http/node.json (GRE-451)

`generate.mjs` uses the same copied database after its `seed` SQL adds two Sources with no local checkout, Plan 3 (base and add-on layers on those Sources, with a stored kit) and Plan 4 (no layers, with a stored kit that is not JSON). It sends 46 requests in order to the kit-manifest and plan-manifest-builder routes Rust's `build_router` serves, on the flat, `/api/v1` and `/api/v2` mounts: kit reads (stored, unreadable, never saved, `HEAD`), builder reads, saves (full, partial, unknown keys), and refusals for missing, foreign, zero and non-numeric Plan ids, a missing body, malformed JSON, and every field the kit parser checks. Each case records the complete response and the tables it changed.

Plan 1's base Source names a local checkout. Rust reads checkouts only through a `DraftReads` adapter, and production does not wire one yet, so Rust answers a builder read or kit save on Plan 1 with 503 "Manifest source observation failed". The corpus reads Plan 1's kit, which needs no checkout, and leaves option groups from real checkouts to the slice that wires the adapter.

`ticket_t_10_fixtures` runs the same seed on its copy and replays the cases against `build_router`: 43 exact matches and 3 declared corrections. A corrected case must change no table. Malformed JSON gets Rust's "Request is invalid" (security: no Fastify parser codes). Two saves select an option group that no attached Source defines: Node skips the check and saves, Rust refuses with "is an unknown option group", as `docs/desktop-rebuild.md` documents (validation). They run last, so no later read sees Node's write.

The fixture made three Rust fixes go red then green. A Plan id that cannot name a Plan (`0`, `abc`, `-1`, `1.5`) is now Node's 404 "Profile not found" after authentication, instead of 400 "Request is invalid". An empty body is now "kit is required". Selection and replacement refusals now use Node's text: `kit.selections group ids must not be empty`, `kit.selections.<group> must be a non-empty string`, `kit.selections.<group>[<index>] must be a non-empty string` (checked for every entry before duplicates), `kit.selections.<group> must not contain duplicate variant ids` and `kit.replacements.<key> must be a string`.

```sh
node fixtures/parity/manifest-http/generate.mjs --check
```

## catalog-http/node.json (GRE-451)

`generate.mjs` uses the same copied database after its `seed` SQL adds Source 2 (tenant `default`, with an import rule and a category), Source 3 (tenant `foreign`) and five activity events, one for `foreign`, one of another kind and one whose payload is not JSON. It sends 56 requests in order to the catalog routes Rust's `admit_catalog_routes` serves, on the flat and `/api/v1` mounts: Source list, detail, create, patch and delete, import rules, Source activity, Source naming, Source categories, global STL naming and its preview, with their missing, foreign, non-numeric, duplicate, retained-history and invalid-body refusals. Each case records the complete response and the tables it changed. A created Source's `local_path` sits under Node's scratch data directory, so the golden writes that directory as `{data}`, and the Rust test writes its sandbox the same way.

Creating a GitHub Source makes Node start a `sync` job, which would clone over the network. The generator replaces the job runner's `start` with a stub that records the call, and the case lists it under `effects`. Rust's catalog create starts no job; the test checks that the only recorded effect is that one `sync` start, and that Rust and Node changed the same tables (`projects` only).

`ticket_t_10_fixtures` runs the same seed on its copy and replays the cases against `admit_catalog_routes`: 53 exact matches and 3 declared corrections, none of which writes anything. Malformed JSON gets Rust's "Invalid JSON body" (security: no Fastify parser codes). Renaming a Source to a taken name gets "Source already exists: <name>", Node's create refusal, instead of Node's SQLite constraint text (security). An invalid global naming profile gets Rust's "Invalid export role order" instead of zod's issue path (validation).

The fixture made three Rust fixes go red then green. Source naming refusals now carry Node's `code` (`source_not_found`, `invalid_source_naming`, `source_naming_conflict`, `invalid_source_naming_state`) next to `detail`. A naming id that is not a positive integer (`abc`) is now Node's 400 "Source id must be a positive integer" instead of 404, and a body without a boolean `use_defaults` gets Node's discriminator message. The naming preview now writes a whole `quantity` as `2`, as `JSON.stringify` does, instead of `2.0`.

```sh
node fixtures/parity/catalog-http/generate.mjs --check
```

## auth-reset/node.json (GRE-864)

`generate.mjs` drives Node's `POST /auth/forgot-password` for a known account, an unknown account, and a rejected loopback delivery. The golden records one shared public response, plus delivery counts, reset-token counts, and the mail-failure error class. Addresses and tokens stay out of the file. `rust/crates/pp-api/tests/auth_reset_parity.rs` replays the cases. See [auth-reset/README.md](auth-reset/README.md).

## custom-filaments.json (GRE-579)

Golden for `web/apps/server/src/services/custom-filaments.ts`.

- **Shipped entries: 0.** The TS source contains no built-in custom filament list. Custom filaments are user data in `custom_filaments.json` under the data dir, created through `addCustomFilament`. The golden records the empty shipped catalog and the entry shape.
- **Flags: none.** The entry type has no flag field.
- The vitest check `web/apps/server/src/services/custom-filaments.parity.test.ts` confirms the golden against TS: an empty store lists zero entries, and an added entry has exactly the fields listed in `entry_fields`.

### Filaments flagged by West3D

The research brief "Print Partner Rust conversion gap review (2026-10-09)" lists these four as wrong hex values in `services/custom-filaments.ts`:

| Name | Found in `custom-filaments.ts`? | Values |
| --- | --- | --- |
| Burnt Orange | No | Not shipped by TS. Unchanged. |
| Midnight Purple | No | Not shipped by TS. Unchanged. |
| Hot Pink | No | Not shipped by TS. Unchanged. |
| Voron Red | No | Not shipped by TS. Unchanged. |

These names exist only in the West3D Shopify catalog, `web/apps/server/src/data/ambrosia_fallback.json`. That file is not a custom filament list. Those values are not in the golden and were not changed. Fixing the data, and deciding whether the brief's reference is correct, is Chad's call.

## community-manifest-slug.json (GRE-681)

Slugs that `isCommunityManifestSlug` in `web/apps/server/src/lib/community-manifest-slug.ts` accepts (`valid`) and refuses (`invalid`). The Vitest check in `community-manifest-slug.test.ts` and the Rust check for `CommunitySlug::parse` in `rust/crates/pp-storage/src/manifest_options/observation_tests.rs` both read this file. It only catches cases it lists: when either grammar changes, add the new edge cases here, as GRE-691 did by reserving `kit-catalog`.

## required-unit-decisions/node.json (GRE-878)

`generate.mjs` copies `accepted-plate-node.db` and `required-units/unsafe.db` to a scratch directory and calls Node's `PlanDraftWorkspaceService` with the Required-unit decisions in its `cases` list: excluding a Part and restoring it, splitting a quantity, accepting a prior completion, and replacing it. Each case closes and reopens the database part way through. The file records each request, its result and the draft rows after it, with the Required-unit, progress and immutable Plate history before the calls. The generator fails if that history changes.

Tokens and reconciliation IDs are replaced with labels numbered in sorted order across the whole case, so every equality link stays visible. `rust/crates/pp-storage/tests/required_unit_decision_parity.rs` sends the same requests through the public Rust clients, applies the same labels and compares the result. It also checks that swapping two reused tokens or clearing the completed progress row makes the comparison fail.

From `web/`, after `npm ci`, with Node 22.23.3 or 24.21.0:

```sh
TMPDIR=<scratch> node --conditions=development --import tsx ../fixtures/parity/required-unit-decisions/generate.mjs [--check]
```

## profile-sync/node.json (GRE-437)

`generate.mjs` runs Node's real `startProfileSyncWatcher` over the three slicer trees in `roots/` (Orca, Bambu Studio and PrusaSlicer, laid out as `defaultWatchDirs` expects), with a repository that records each upsert. It calls `syncAll()` once and stops the watcher. Each outcome is either the table and complete upsert input plus the broadcast event, or `failed` when Node logged a parse failure. Paths are relative to this directory.

The trees hold user saves that inherit a parent (looked up case-insensitively), a missing parent, INI, array, string and `null` parents, a `type` field that overrides the directory, BOM and CRLF files, Unicode separators (U+2028, U+2029, U+00A0, U+3000, U+FEFF, U+0085) at trim and `\s` boundaries, malformed JSON, a directory named `*.json`, number formatting cases, duplicate and array-index keys, and material names for `inferMaterialType`. `.gitattributes` keeps line endings byte-exact on Windows checkouts.

`rust/crates/pp-services/tests/ticket_t_60_profile_sync.rs` scans the same roots with `pp_services::profile_sync::scan_root` and requires every outcome to match, in order, including the `resolvedFlatConfig` string byte for byte.

```sh
cd web && node --conditions=development --import tsx ../fixtures/parity/profile-sync/generate.mjs --check
```
