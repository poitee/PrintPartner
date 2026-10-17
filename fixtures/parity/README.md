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

Slugs that `isCommunityManifestSlug` in `web/apps/server/src/lib/community-manifest-slug.ts` accepts (`valid`) and refuses (`invalid`). The Vitest check in `community-manifest-slug.test.ts` and the Rust check for `CommunitySlug::parse` in `rust/crates/pp-storage/src/manifest_options/observation_tests.rs` both read this file, so a grammar change on either side fails a test until both sides agree.
