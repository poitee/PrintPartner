# Parity fixtures

Golden data captured from the TypeScript app, used as the reference for the Rust port.

## Parity runner (GRE-451, T-10-fixtures)

`pp_api::fixtures`, behind the default-off `desktop_rebuild` feature, replays copied fixtures against Rust routers on disposable data directories with no OAuth provider and no mailer. `Ledger` requires each Rust response to equal Node's status, complete JSON body and literal `Set-Cookie` headers, unless the case has a declared `Correction`. A correction names its kind (security, WebSocket, or durable-store) and reason, and holds the literal Rust response. It fails if Rust now matches Node, if it is never used, or if it is declared twice. `StateGraph` records every row of every SQLite table and the SHA-256 of every other file, so a test can compare state changes as well as responses.

`rust/crates/pp-api/tests/ticket_t_10_fixtures.rs` runs `auth-login` (11 exact, 3 security corrections, no state change on any refusal) and `auth-session` (4 exact, 3 clearing-cookie corrections, Node's session row count, and only the `sessions` table changing when that count moves). It also runs `jobs-http`, `plans-http`, `drafts-http` and `layers-http` (see below). Run it with `cargo nextest run --locked --manifest-path rust/Cargo.toml --features desktop_rebuild --no-tests=fail -E 'test(ticket_t_10_fixtures)'`.

## jobs-http/node.json (GRE-451)

`generate.mjs` registers Node's real job read routes, flat and under `/api/v1`, over an `InProcessJobRunner` that has finished an update check and, a second later, failed a checklist export for profile 7. It records 13 complete responses: the `/api/v1/jobs` list under each filter, both jobs on both read-one aliases, and an unknown id on both aliases. Job ids and timestamps become labels numbered in first-seen order (`job-1`, `time-1`); `pp_api::fixtures::Labels` labels the Rust responses the same way.

`ticket_t_10_fixtures` replays the cases against `jobs_router`, with 5 exact matches and 8 declared durable-store corrections: Rust snapshots add `created_at`, and a failed durable job reports "Job failed" and its last progress instead of the handler's in-memory error (both documented for GRE-609 in `docs/desktop-rebuild.md`). The reads change no table or file. Node's read-one returns the stored snapshot without `updated_at`, which only its list adds; Rust's read-one now does the same.

```sh
node fixtures/parity/jobs-http/generate.mjs --check
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

`generate.mjs` uses the same copied database after its `seed` SQL adds three Sources with no files (two for tenant `default`, one for `foreign`). It sends 29 requests in order to the Plan layer mutations Rust's `build_router` serves, on the flat, `/api/v1` and `/api/v2` mounts: attach an add-on, replace it, set the base, detach, and their duplicate, missing, foreign and no-Source refusals. Each case records the complete response and the tables it changed.

`ticket_t_10_fixtures` runs the same seed on its copy and replays the cases against `build_router`: 29 exact matches, no corrections, and the same changed tables for every case. The fixture made one Rust fix go red then green. Node reads `project_id` with `Number()`, so a body with no usable id (missing, `null`, `0`) passes Node's Plan check and then finds no Source: 404 "Project not found" (or "Layer not found" for a replace of a layer the Plan does not have). Rust refused such a body with 400 "Request is invalid"; it now gives Node's answers and writes nothing. A body that is not a JSON object is still a 400.

```sh
node fixtures/parity/layers-http/generate.mjs --check
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
