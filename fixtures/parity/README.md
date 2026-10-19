# Parity fixtures

Golden data captured from the TypeScript app, used as the reference for the Rust port.

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
