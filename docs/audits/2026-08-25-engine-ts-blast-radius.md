# `web/apps/web/src/api/engine.ts` blast radius and migration plan

## Current blast radius

`engine.ts` is the web app's API compatibility façade. It currently mixes transport, endpoint functions, DTO types, URL builders, media cache helpers, browser file helpers, and a few domain-ish payload rules.

Measured on 2026-08-25:

- `engine.ts`: 3,293 lines.
- Exports: 321 total.
- Exported functions: 217.
- Direct source/test files that import it or import through `api/engine`: 175.
- Existing endpoint modules: `api/endpoints/sourceNaming.ts`, `api/endpoints/acceptedPlates.ts`.
- Existing transport split: `api/engineTransport.ts`.

Caller clusters:

| Cluster | Files |
| --- | ---: |
| `lib/*` | 51 |
| `pages/*` | 20 |
| `queries/*` | 17 |
| `components/checkoff/*` | 11 |
| `context/*` | 9 |
| `components/export/*` | 9 |
| `components/settings/*` | 8 |
| `hooks/*` | 8 |
| `api` tests/endpoints | 7 |
| `components/sources/*` | 6 |
| `components/review/*` | 5 |
| `components/build/*` | 5 |
| `components/share/*` | 3 |
| `components/parts/*` | 2 |
| Single-file component callers | 14 |

## Why direct migration is risky

The interface is not just the function list. Callers also rely on:

- Re-exported contract types from `@print-partner/contracts`.
- Browser helpers such as file pickers and downloads.
- URL construction helpers for meshes, previews, thumbnails, legal docs, and Bambu handoff downloads.
- Job/start endpoints returning job ids with specific casing.
- Accepted media cache behavior. There is a caller inventory test that deliberately treats `api/engine.ts` as the accepted-media seam.
- Tests that mock `api/engine` wholesale.

Changing imports across 175 files in one pass would hide regressions in mocks, query invalidation, browser-only behavior, and accepted-media caching. The right move is replace-don't-layer: keep `engine.ts` as the public compatibility interface while moving implementation to narrower endpoint modules behind it.

## Current migration progress

Moved behind the `engine.ts` façade in this audit:

- `api/engineTransport.ts`: HTTP error, JSON/text fetch, idempotency keys.
- `api/endpoints/help.ts`: health, app update check, legal docs, workflow guide.
- `api/endpoints/auth.ts`: auth session, email auth, password changes/resets, OAuth URLs, plan sharing.
- `api/endpoints/sources.ts`: Source Library list/CRUD, categories, STL search/tree, import rules, import scan.
- `api/endpoints/printers.ts`: printer fleet, printer presets, details, preferred slicer.
- `api/endpoints/filaments.ts`: filament catalog, custom filaments, role filaments, Spoolman default/spools.
- `api/endpoints/integrations.ts`: integration list/create/update/delete/test/status.
- `api/endpoints/slicers.ts`: slicer profile options, slicer instances, Docker controls/logs.
- `api/endpoints/printerSettings.ts`: printer Plan bindings and printer profile assignments.
- `api/endpoints/productionSetup.ts`: production setup and profile library.
- `api/endpoints/productionSend.ts`: printer send queue, queue suggestions, Bambu Connect handoff, printer upload jobs.
- `api/endpoints/media.ts`: accepted media metadata/revalidation, thumbnail upload, preview/mesh URL builders.
- `api/endpoints/checkoff.ts`: accepted checkoff/progress, printer checkoff, print outcomes, unattributed prints.
- `api/endpoints/sourceContent.ts`: GitHub refs, GitHub PAT, Source update settings/job, Source docs/readme/notes.
- `api/endpoints/sourceArtifacts.ts`: Source uploads, repo manifests, Source maintenance, repos.txt import, community manifest export draft.
- `api/endpoints/assistant.ts`: assistant status/history/chat/streaming, feedback, action apply/dismiss, decisions.
- `api/endpoints/settings.ts`: date format, Discord notify, build tracking settings.
- `api/endpoints/plans.ts`: Plan CRUD, layers, grouped parts, part filament patching.
- `api/endpoints/planDrafts.ts`: Plan draft lifecycle, reconciliation, apply, accepted progress import.
- `api/endpoints/planSnapshots.ts`: Plan recipe and snapshots.
- `api/endpoints/stlNaming.ts`: STL naming settings, preview, and merge helper.
- `api/endpoints/jobs.ts`: sync/export job starts, job polling, job WebSocket connection.
- `api/endpoints/planManifests.ts`: manifest catalog/templates/registry, Plan manifest review/summary/warnings, kit manifest, build-planning reads.
- `api/endpoints/browserFiles.ts`: kit bundle upload/import, local picker adapters, export download/asset URL helpers.
- `api/endpoints/planVariants.ts`: Plan phase manifest and variant dimensions/selection helpers.
- `api/endpoints/runtime.ts`: runtime façade helpers for sync time, engine base URL, health reachability, and short SHAs.
- `api/endpoints/sourceNaming.ts`: Source naming settings.
- `api/endpoints/acceptedPlates.ts`: accepted plate operations.

Still implemented directly in `engine.ts`:

- `engine.ts` is now a compatibility façade; next work is caller migration by vertical slice, not more implementation extraction.
- `lib/sourceImportModel.ts`: pure Source Library import/upload decisions and repos.txt import/sync messages extracted from `SourcesPage.tsx`.
- `lib/buildPageViewModel.ts`: derived Build page header, warnings, next-step, and archive eligibility extracted from `BuildPage.tsx`.
- `lib/checkoffPageModel.ts`: Checkoff live-strip comparison, verify-first progress mode copy, part filtering, visible row filtering, and ordered print-sheet parts extracted from `CheckoffPage.tsx`.
- `server/src/assistant/accepted-plan-reader.ts`: accepted Plan read/missing/integrity-failure adapter extracted from `assistant/tools.ts`.
- `components/checkoff/CheckoffSheetRow.tsx`: print-sheet row component extracted from `CheckoffPage.tsx`.
- `components/settings/PrinterDetailsEditor.tsx`: printer geometry/details editor extracted from `PrintersSettingsCard.tsx`.
- `components/settings/SlicerInstanceRow.tsx`: slicer instance row extracted from `SlicersSettingsCard.tsx`.
- `lib/stickyIdStorage.ts`: browser sticky ID storage adapter extracted from `PrinterSendPanel.tsx`.
- `server/src/assistant/source-tool-model.ts`: assistant Source lookup, Source-not-found hints, category-not-found payloads, category counts, and Source Library category summaries extracted from `assistant/tools.ts`.
- Caller migration started: Settings, Export leaf components, `SourcesPage`, `BuildPage`, and `CheckoffPage` now import endpoint modules directly instead of the `api/engine` façade where practical.
- Low-risk lib type imports moved from `api/engine` to their owning contracts/endpoint modules for printer send/settings, slicer settings, role preview color, review parts, workflow stages, checkoff page/activity, Build page view model, and Source import model.
- Query/context caller migration: profile, plan-layer, plan-review, plan-draft, role-filament, build-tracking, production-setup, source-category, source, plan-recipe queries plus PlanWorkspace, Job, Auth, DateFormat, and Profile contexts now use endpoint modules/contracts directly.
- Hook migration: app-update, engine-health, import shared build, import-rules autosave, kit-manifest autosave, Spoolman status, job runner, and health query now use endpoint modules/contracts directly.
- More lib migration: checkoff/proposal/phase/review/parts/global-production/export/spool/kit-import helper modules now use owning endpoint modules/contracts instead of `api/engine`.
- Small page migration: auth reset/login pages, Help, and Settings now use endpoint modules/contracts directly.

## Target module shape

Keep this external seam during migration:

```ts
// Existing callers keep this until their cluster migrates intentionally.
import { fetchSources, fetchProfiles } from "../api/engine";
```

Add internal endpoint modules with smaller interfaces:

```txt
api/engine.ts                 compatibility façade, re-exports endpoint functions/types
api/engineTransport.ts        fetch, text fetch, idempotency keys, HTTP error
api/endpoints/auth.ts         login/register/session/password
api/endpoints/sources.ts      Source Library CRUD, categories, STL tree/search, upload/import
api/endpoints/plans.ts        plan CRUD, layers, shares, snapshots, drafts
api/endpoints/production.ts   printer send queue, uploads, Bambu handoff, slicers
api/endpoints/printers.ts     fleet machines, presets, integrations, host status
api/endpoints/checkoff.ts     accepted progress, printer checkoff, unattributed prints
api/endpoints/media.ts        accepted media metadata, preview/mesh URLs, thumbnail upload
api/endpoints/filaments.ts    catalog, custom filaments, role filaments, Spoolman defaults
api/endpoints/assistant.ts    chat, history, proposed actions, usage
api/endpoints/help.ts         legal/help/update/health
```

Each endpoint module should own endpoint-local request/response types when they are not contract-derived. Contract-derived types should continue to come from `@print-partner/contracts`.

## Migration plan

### Phase 0: lock behavior before moving more code

- Keep `engine.ts` exports stable.
- Add a simple generated inventory test for exported function names if churn keeps increasing.
- Keep accepted-media caller inventory unchanged until `api/endpoints/media.ts` exists and the inventory test is updated in the same commit.

### Phase 1: move implementation behind the façade

Move clusters one at a time. For each cluster:

1. Create `api/endpoints/<cluster>.ts`.
2. Move the endpoint functions and local helper types into it.
3. Import shared transport from `engineTransport.ts`.
4. Re-export the moved functions/types from `engine.ts`.
5. Keep callers importing from `api/engine`.
6. Run focused tests for that cluster plus web typecheck.

Suggested order:

1. `help/health/update/legal`: done in this audit.
2. `auth/share`: done in this audit.
3. `sources`: core list/CRUD/category/STL/import-rule/import-scan endpoints done in this audit; docs/upload/manifest/update endpoints remain.
4. `printers/settings`: printer fleet/presets, filament/Spoolman role-color endpoints, integrations, slicers, printer Plan bindings, and printer profile assignments done in this audit.
5. `production`: production setup/profile library and send queue/Bambu/upload jobs done in this audit.
6. `media`: done in this audit; accepted-media inventory test updated in the same pass.
7. `plans/drafts/snapshots`: larger, move after BuildPage and plan draft seams settle.
8. `assistant`: large but mostly route-shaped; move once proposed action and tool-model seams are stable.

### Phase 2: migrate callers by vertical slice

After endpoint modules exist and `engine.ts` is only a façade, migrate imports by feature cluster:

1. Queries first (`queries/*`), because they are already adapters for React Query.
2. Context/hooks next.
3. Feature components/pages last.
4. Tests last, unless a test needs to mock a narrower module to get simpler.

Do not mix call-site migration with endpoint implementation moves. One kind of change per commit keeps regressions local.

### Phase 3: shrink the façade

When direct imports from endpoint modules are stable:

- Stop adding new endpoint exports to `engine.ts`.
- Add an ESLint no-restricted-imports rule for new `api/engine` imports outside explicitly allowed legacy files.
- Remove compatibility exports only after all production callers have moved.
- Keep a tiny `engine.ts` only if tests or plugin-like code need a stable aggregate interface.

## Definition of done

`engine.ts` is proper when:

- It contains no endpoint implementation, only compatibility exports or is deleted.
- Transport lives only in `engineTransport.ts` / `contractRequest.ts`.
- Endpoint modules are organized by product seam, not HTTP method.
- Browser-only helpers are isolated from fetch-only endpoint modules.
- Accepted media cache rules have their own module and inventory test.
- New feature code imports the narrow endpoint module it uses, not the aggregate façade.

## Do not do

- Do not rewrite all call sites in one pass.
- Do not introduce a generic generated API client unless server contracts are ready to generate it.
- Do not move accepted-media helpers without moving/updating the inventory test.
- Do not duplicate endpoint functions in both `engine.ts` and endpoint modules. Move implementation once, re-export from the façade.
