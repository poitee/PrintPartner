# Changelog

All notable changes to Print Partner are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Simpler external tools settings** - Settings now lets you turn off API-key
  and MCP controls, allow API keys only, or enable both. Turning them off keeps
  Sources, Plan, Production, Checkoff, printers, backups, and logs available.
  Existing installations keep API and MCP enabled until you change the setting.

### Fixed

- **Milo V2 source planning** - Deep GitHub tree links now keep their selected
  branch instead of silently importing `main`. The LDO kit spindle mount appears
  beside the 65 mm and 80 mm choices, inferred source choices are enforced when
  the Working Plan is built, and unchecked files remain outside the Plan.
- **Large local folders** - Browser folder imports now accept up to 10,000 files,
  matching the existing archive-entry limit instead of failing after 100 files.

## [3.3.0] - 2026-09-01

### Added

- **Autopilot skill** - in-repo `/autopilot` workflow that takes an open PR
  to merge-ready (conflicts, then review threads, then CI). Includes a
  `pr-state.mjs` helper, a Cursor Automation prompt, and
  `docs/agents/autopilot.md`.

- **Source subcategories** - library categories now nest. A category is a
  "/"-separated path, so "Voron" can hold "Voron/Voron 2.4" and
  "Voron/Stealthburner". The Settings manager gains an "Add sub" action per row,
  the Library rail nests and collapses with rolled-up counts, and selecting a
  category also shows everything filed beneath it. Renaming or moving a category
  carries its subcategories and their Sources; deleting one drops its Sources to
  the surviving parent, or Uncategorised at the top level. The saved list stays a
  flat array of paths, so existing flat categories load unchanged.

- **Categories over MCP** - new `list_source_categories`, plus propose-and-
  confirm `propose_set_source_category`, `propose_create_source_category`,
  `propose_rename_source_category`, and `propose_delete_source_category` tools.
  `list_sources` takes a `category` filter (with `include_subcategories`), and a
  `print-partner://source-categories` resource serves the tree.

- **Text-only print sheet** - Progress and Plan can print the checkoff sheet as a
  plain text list instead of thumbnail rows, fitting far more parts per page.
  The toggle is remembered per browser and only affects print output; the
  on-screen sheet keeps its thumbnails.

- **Accepted Plate workflow** - accepted Plans now publish immutable Plate
  revisions with explicit Printer allocation, saved fixed-point placement,
  deterministic Required-unit 3MF identity, revision-keyed downloads, and
  local slicer handoff. The Export page uses this state on desktop and mobile.

### Changed

- **Compose publishes 8080 on every host interface** - `docker compose up`
  is reachable from other machines on the LAN. Set `PP_BIND_ADDRESS=127.0.0.1`
  to keep it on this computer, and enable authentication on an untrusted
  network. Existing installs that never set `PP_BIND_ADDRESS` pick this up on
  the next `docker compose up -d`. The image already listened on `0.0.0.0`
  inside the container.

- **Plan acceptance is one checkpoint** - Plan no longer stacks empty Issues,
  Final review recap, and Required-unit cards above Accept. Working changes,
  open issues, parts, and the accept action (with unit impact) are the whole
  loop. Checkoff no longer banners Source freshness as if printers were blocked.

- **Desk chrome** - the signed-in app and the sign-in screens now share one brass
  desk canvas. Build stages name the stage and the Build in the top bar. The rail
  marks the current page with a brass bar, empty states use the page title voice,
  and Settings sections read as real headings.

- **Compressed responses and immutable asset caching** - the server now serves
  brotli/gzip for pages, assets, and API JSON (event streams stay unbuffered),
  and content-hashed assets cache for a year. First-load JS drops from ~1 MB
  to ~350 KB on the wire.

- **Upload size caps removed** - the server no longer enforces request-body,
  multipart, STL mesh, or PNG thumbnail byte limits, and `UPLOAD_MAX_BYTES` is
  no longer read. Free disk space is the only bound; put a request body limit
  on the reverse proxy if you need one.

- **Direct export mirrors the Plates arrangement** - the named-object 3MF from
  Direct Export places each unit exactly where the published Plates showed it,
  falling back to a spaced strip for units without a saved placement. Plate
  meshes are welded on shared edges, and the Export page's Recent panel links
  each Plate's 3MF plus a zip of all of them.

### Fixed

- **Checkoff crashed in Vite** - Progress imported object matching through the
  domain barrel, which also exports the STL scanner. The scanner uses
  `node:fs`, so the browser page died with "Something went wrong". Checkoff now
  imports the matching module directly.

- **Printers sat on "needs review" with nothing to do** - Source changes no
  longer steal the Build's next action from Production once a Plan is accepted.
  Plan presents them as available updates, says the published revision remains
  usable, and offers Continue to Production first instead of a publishing check.
  A Plan with no accepted inputs no longer lists "source revisions are not
  tracked" as an issue, and an empty Build no longer lists "no parts included"
  as something to review. Sliced 3MF files on a printer read as ready to assign,
  not "compatibility review required". A damaged Accepted Plan says to restart
  PrintPartner, not to review compatibility.

- **Part thumbnails stayed empty squares** - auto-sync no longer deletes cached
  pictures when some are missing. Empty thumbs render in the background. Print
  waits up to two minutes for real pictures, then prints what it has and says
  how many are still missing. A failed render shows the filename letters
  instead of a blank square.

- **Legacy sidecar zip could be sent as G-code** - a zip body from the old
  `/slice` protocol that failed to unzip, or unzipped with no `.gcode` file,
  was returned as the G-code payload. The printer would have received an
  archive. That path now throws `invalid_zip` or `empty_gcode`.

- **STL sync status never appeared** - `StlAutoSyncProvider` already computed
  the banner, but nothing rendered `StlSyncBanner`. Missing or failed STL
  syncs now show in the app shell with a Sync retry.

- **Incoming shared builds had no inbox** - `IncomingSharesCard` existed and
  the `/shares/incoming` API worked, but Builds never mounted the card.
  Multi-user inboxes now list those shares on Builds.

- **Farm send queue had no operator surface** - `PrinterSendQueuePanel` was
  unmounted. Checkoff reports printer status and does not dispatch, so the
  panel now sits on the Production send task next to Send / Start print.

- **IPv4-mapped IPv6 bypassed the outbound URL guard** - Node rewrites
  `[::ffff:127.0.0.1]` to `::ffff:7f00:1`, which the classifier treated as
  public. Loopback and cloud-metadata mapped addresses are blocked.

- **Changing a password left other sessions valid** - reset already dropped
  every session. Change-password now does the same, then mints a cookie for
  the current request.

- **Two drain requests could start two jobs on one printer** - the claim now
  refuses while another item for that printer is already sending.

- **`?select=missing` could not stick** - a Production setup save changed
  `updated_at` and reapplied the query param over a custom selection.

- **Checkoff wiped "completed at" on a cold load** - empty parts while the
  review was loading looked like an unfinished Build and cleared the receipt.

- **Unclaimed-print claim hid when profile fetch failed** - the card now uses
  the parent's plan list, and busy state always clears.

- **Plan sheet could wedge on a stale draft** - rebuilding the plan twice left
  two open drafts; applying the newer one stranded the sheet on the older,
  whose base version could never match again, so every edit failed with a
  conflict. A recompute now abandons the open drafts it supersedes.

- **Console 404s on Library and Checkoff** - a source without a cover image now
  answers 204 instead of 404 (and the card probes covers silently), and
  `GET /plans/:id/phase-manifest` is served (has_phases false without a
  pp-phases.json, the parsed phases when a source ships one) instead of
  falling through to the API 404 handler on every Progress load.

- **Plan Remove/Restore did nothing** - the Plan sheet resolved a row to the
  saved draft by `part_key` alone and required exactly one match, so a duplicate
  key or a draft that no longer carried the key threw before any error was
  recorded. The click discarded that rejection, leaving a dead button. Rows now
  fall back to source layer plus relative path, and every failure reports through
  the Plan page alert.

- **MCP clients dropped while idle** - HTTP MCP sessions now refresh before the
  idle sweep, a session holding an open SSE stream is never evicted, and an
  unknown session id answers 404 so clients re-initialize silently instead of
  surfacing a protocol error.

### Removed

- **Legacy Plate and auto-slice APIs** - removed mutable `print-plan`,
  `print-groups`, `print-assignments`, `plate-workspace`,
  `print-plan/prepare-missing`, `pack-preview`, `export-3mf`, `auto-slice`, and
  `open-plates` routes from flat and `/api/v1` surfaces.
  Automation must use `export-accepted-plate-3mf` with an observed Plate
  revision. Schema v28 deletes only persisted `print_plan:<Build id>` layout
  keys; it does not translate match-key layouts into accepted identity.

## [3.2.0] - 2026-08-20

### Added

- **Verifiable release identity** — one release command now prepares and checks
  every current version sink. Release images carry the peeled Git commit and
  tag in runtime health and OCI metadata; GitHub Releases attach the image
  digest in `release-identity.json`.
- **Multi-printer 3MF print plan** — Export uses the kit’s enabled fleet machines (Settings → Printer fleet + Export “Printers for this plan”). Parts assign by loaded `filament_color_id`, pack per bed, and write one 3MF per plate (zip / single-offset / single-plate-only modes) plus a `print_plan.json` manifest. Settings slots use the filament catalog picker; Export shows a printer → filament → parts assignment tree and per-printer plate estimates. Preview packing, assignment warnings, and checkbox state honor the same enabled-printer fallback as export. Plate filenames include the printer id so duplicate names cannot overwrite each other. See `docs/3MF_EXPORT_VALIDATION.md`.
- **Auto-sync missing STLs + background thumbs (GRE-235)** — when a plan is selected (or Parts opens / compose applies) and STLs are missing or thumbs are empty, one coordinated job syncs sources then regenerates thumbnails. Parts shows Spinner + “Syncing STLs…” while running; Sync remains as retry on failure or if files are still gone. Review parts expose `stl_missing` / `thumb_empty` (distinct from checkoff `missing`).
- **HTTP MCP attach (GRE-225)** — streamable HTTP at `/api/v1/mcp`; `PRINT_PARTNER_API_KEY` required unless `HOST` is loopback; pending proposes are per MCP session; Cursor plugin at `cursor-plugin/print-partner`; tools `get_remaining`, `duplicate_plan`, `archive_plan` (confirm-to-apply). Connect guide: `docs/assistant-mcp.md`.

### Removed

- **Snyk** — dropped the committed VS Code Snyk org binding; CI no longer uses Snyk PR checks.
- **In-app kit advisor (GRE-225)** — Ask assistant / Kit Advisor sheet, Settings → AI, and `/assistant/chat` (410). Desk loop unchanged; attach Cursor / Grok / Claude via MCP instead.

### Added (prior)

- **Live printer hosts (desk-first)** — Moonraker and PrusaLink: Settings hosts, fleet bind, Export **Send to printer** / **Queue for idle** / **Any matching idle** (same bed + filament preference), Progress live strip, and **verify-first** Progress (confirm/reject + failure-reason outcomes). Bambu: LAN MQTT **status** plus Export **Open in Bambu Connect** (official URL handoff; no MQTT print-start). Setup: `docs/integrations/PRINTER_SETUP.md`.
- **Kit advisor product tools + stdio MCP (GRE-201)** — product verbs with confirm-to-apply; prefer HTTP MCP on the live host (GRE-225).
- **Unified Parts / Progress workspace** — print checkoff lives on **Progress** (legacy `/checkoff` redirects there); Parts covers validation and quantities; STL/3MF export and missing-STL export remain available from Parts / Export.
- **Published Docker images** — releases now push multi-arch (`linux/amd64` + `linux/arm64`) images to `ghcr.io/poitee/print-partner` with `latest` and version tags, so `docker compose pull && docker compose up -d` works without building from source.
- **Release workflow** — pushing a `vX.Y.Z` tag builds and publishes the image (with the version baked into `PP_VERSION`) and creates a GitHub Release with auto-generated notes (`.github/workflows/release.yml`).
- **Container healthcheck** — the app service in `docker-compose.yml` and `docker-compose.saas.yml` now polls `GET /health` via Node's built-in `fetch`.
- **Build plan management** — create, rename, duplicate, and delete plans from the Build tab (restores `PlanManager` wiring lost during the web migration).
- **Branding** — project logo (`docs/logo.png`) on the README and GitHub Pages landing page; GitHub Sponsors support badge near the top of both.
- **Regenerate thumbnails** — a button in the Build tab's "Role filament colors" section clears cached part thumbnails/previews (`POST /plans/:id/regenerate-thumbnails`) so updated colors re-render.
- **Save & import colors** — export the current role filament colors to a `print-partner-colors.json` file and import it into any plan from the Build tab.
- **Share build re-adds sources** — importing a shared `.print-partner-kit.zip` now offers one-click "Add & sync" for each referenced repo (using the URL/branch/source kind carried in the bundle), recreating the source, applying its import rules, attaching it to the correct layer (base/add-on), and starting a sync.
- **Clear checkoff on duplicate** — the Duplicate plan dialog has a "Clear checkoff progress" toggle so a copied plan can start with nothing marked printed (`POST /plans/:id/duplicate` accepts `clear_checkoff`).

### Changed


- **Color editor redesign** — the Build tab's "Colors by part type" section now uses a click-to-open color picker per role: a custom-color (hex) field plus a searchable filament catalog shown as product-thumbnail + name rows. Selected catalog colors show their product photo on the role swatch.
- **Release publication order** — CI validates the annotated tag before
  publishing, creates the GitHub Release before the immutable version image
  alias, verifies matching existing artifacts on retry, and advances `latest`
  only after the release identity passes.

### Fixed

- **Failed `v3.1.0` publication path** — removed the unsupported GHCR visibility
  mutation that previously allowed an image push to succeed before GitHub
  Release creation failed. The disconnected historical tag remains unchanged.
- **Kit-import setup panel** — the "Share import setup" panel now reliably appears after importing a shared build; the `?profile=` URL sync no longer drops the navigation state, and the import result is also handed off via a sessionStorage stash as a fallback.

## [3.1.0] - 2026-08-15

### Added

- **Operations management UI** — frontend controls for backups, integration API keys, and runtime logging configuration.
- **Request rate limiting** — per-IP protection for API routes, with proxy-aware client identification.
- **Prometheus metrics** — `GET /metrics` exposes HTTP, print-job, plan, printer, filament, runtime, and application-version metrics.
- **Database optimization guide** — indexing, maintenance, monitoring, and query-tuning guidance in `DATABASE_OPTIMIZATION.md`.

## [3.0.0-web] - 2026-05-31

Print Partner is now a **single web platform**. The **Sources → Build → Review → Checkoff** workflow moves to a TypeScript monorepo under `web/`: a Vite + React single-page app (`web/apps/web`) and a Fastify API (`web/apps/server`) served together on one port, with shared `contracts` and `domain` packages.

### Added

- **Docker self-host** — `docker compose up --build` serves the API + SPA on port 8080; data persists in the `print-partner-data` volume at `/data` (SQLite, synced repos, exports, thumbnails). Config via `PRINT_PARTNER_DATA_DIR`, `HOST`, `PORT`, `STATIC_DIR`, `DEPLOY_MODE`, `CORS_ORIGIN`/`ALLOWED_ORIGINS`, `BASIC_AUTH_USER`/`PASS`, `UPLOAD_MAX_BYTES`, `PP_VERSION`.
- **SaaS mode** (`DEPLOY_MODE=saas`) — multi-tenant hosting with Postgres app data (`DATABASE_URL`), S3-compatible blob storage (`S3_BUCKET`), GitHub OAuth, and an optional Redis/BullMQ job queue. Ready-to-run `docker-compose.saas.yml` stack (Postgres 16 + RustFS/S3-compatible).
- **Ports/adapters architecture** — `self-host` (SQLite + local disk) and `saas` (Postgres + S3) adapters behind shared ports; Drizzle ORM with SQLite or Postgres; client-side Three.js STL rendering; background job runner with `/ws/jobs/:id` progress.
- **Desktop-data migration** — import an existing `~/.print-partner` SQLite DB and repos into the web data dir (see `web/DEPLOY.md`).

### Removed

- **Legacy desktop app** — the Python/PySide6 + Tauri desktop code, PyInstaller packaging, and desktop-only CI/docs are removed; the web platform is the canonical codebase.

### Changed

- **Documentation** — root `README.md`, `AGENTS.md`, `docs/ARCHITECTURE.md`, and the GitHub Pages landing page (`docs/index.html`) rewritten for the web platform, with regenerated workflow screenshots.

## [2.0.0] - 2026-05-31

Major release: Tauri + React desktop replaces the legacy Qt UI. Workflow is **Sources → Build → Review → Checkoff** with a quantity-aware STL exporter instead of in-app bed planning.

### Added

- **Tauri + React desktop** — primary shell with sidebar workflow, command palette (⌘K), job tray, and plan picker.
- **Build** — attach sources, pick STLs, set quantities; **role filament colors** (primary/accent/clear/opaque) with bulk apply and tinted 3D previews; **Docs** button on source cards to read synced repo READMEs.
- **Review** — editable parts list (add/remove/change quantities); validation summary; **Export STLs** by role and folder with quantity copies.
- **Checkoff** — per-unit print progress (persisted); filter missing/done; **Export missing STLs** into a rebuilt `stl-missing/` folder; checklist HTML export.
- **STL export layout** — `~/.print-partner/exports/{plan}/stl/{role}/{folder}/` and `stl-missing/` for outstanding parts only.
- **Sources** — user-managed categories, grid/list view, global STL search, remote update-check badges.
- **Settings** — configurable STL naming rules and source update interval.
- **Open data folder** — sidebar footer, Settings, and Help links to `~/.print-partner`.
- **Share build** — config-only `.print-partner-kit.zip` (no STLs); import via ⌘K.
- **License at release time** - version 2.0.0 used the former Print Partner Non-Commercial Software License. Current releases use [CC BY-NC 4.0](LICENSE); see [LICENSE-SUMMARY.md](LICENSE-SUMMARY.md).

### Removed

- **Legacy Qt UI** — entire `print_partner.ui` tree and PySide6 dependency.
- **Plate page and printer fleet UI** — bed assignment and 3MF plate planning removed from the desktop shell; export focuses on organized STL folders.

### Changed

- **CI/release** — engine bundles + Tauri matrix on Linux/macOS/Windows.
- **README & docs** — refreshed screenshots and workflow documentation for the four-step flow.

### Fixed

- **Recompute crash** — `compare_geometry` name shadowing in merge layers.
- **Checkoff toggles** — duplicate `print_progress` rows deduped (schema v9); stack reconcile for unit marking.
- **Export paths** — fresh `stl/` and `stl-missing/` directories on each export run.

[2.0.0]: https://github.com/poitee/PrintPartner/compare/v0.3.1...v2.0.0

## [1.0.0] - 2026-05-28

### Added

- **React Build — quantity override** — per-part stepper/input with auto vs override labels; `PATCH /parts/{id}` wired in UI.
- **React Build — STL preview panel** — click a part row to show a larger cached preview via `GET /parts/{id}/preview`.
- **Community manifest browser** — `GET /manifest-registry` lists approved entries; read-only list in Help.
- **Desktop CI** — `.github/workflows/desktop.yml` runs pytest, builds the engine on Ubuntu + macOS, and optionally runs the Vite desktop shell build on macOS.
- **Release workflow** — `release.yml` attaches Qt archives plus `print-partner-engine` Linux/macOS tarballs; optional macOS Tauri bundle (`continue-on-error`). Manual per-OS Tauri builds were documented in `docs/RELEASE_DESKTOP.md` at the time.
- **Desktop verify script** — `packaging/verify_desktop_build.sh` checks engine binary, optional Tauri bundle, and `/health` for 5s.

### Changed

- **Version** — `1.0.0` GA for Tauri-first desktop (~80% Qt parity); beta workflow blockers cleared.
- **Part list API** — profile parts include `quantity_auto` and `quantity_override`.
- **Libraries (React)** — **Browse registry** links to community manifests on GitHub.

### Notes

- Full **`npm run tauri build`** on Windows/Linux remains a **manual release step**; macOS may succeed in CI but is not required. The old desktop release documents are retained in Git history.

## [1.0.0-beta.1] - 2026-05-28

### Added

- **Tauri desktop as default CLI** — `print-partner` launches the built Tauri app when `dist/Print Partner.app` (macOS) or `dist/print-partner-desktop` exists; falls back to Qt with a deprecation warning. Dev helper: `scripts/launch_desktop.sh`.
- **Engine APIs** — `GET /filaments/catalog` (Ambrosia + custom colors), `GET /help/workflow` (markdown workflow guide). OpenAPI at `/openapi.json`.
- **React Build** — per-part filament picker (catalog + custom colors from Settings).
- **React Print** — assignment summary table by printer; improved printer dropdown with enabled/other groups.
- **React Help** — workflow guide loaded from engine; OpenAPI URL shown in Help.
- **OpenAPI client script** — `apps/desktop/scripts/generate-api-client.sh`.
- **Legacy Qt docs** — `docs/LEGACY_QT.md` covered `PRINT_PARTNER_USE_QT=1` at the time.

### Changed

- **Version** — `1.0.0-beta.1` toward v1.0 Tauri cutover (~78% Qt parity).
- **Desktop dev docs** — launcher behavior, catalog/help endpoints, and the OpenAPI workflow were documented in `docs/DESKTOP_DEV.md` at the time.

## [0.4.0] - 2026-05-28

### Added

- **Kit manifest system** — `print-partner.manifest.yaml` at repo root; load/validate/apply in core; **Kit → Manage → Manifest…** editor with option groups, drift warnings after recompute, and **Generate manifest draft** from README + scan.
- **Community manifest registry** — `manifests/` in this repo with PR template, `registry/index.yaml`, and **Import community manifest…** in the app.
- **Performance** — mesh load cache in export pipeline; per-project scan cache keyed by commit SHA; parallel remote update checks; **Help → Fast recompute** (skip geometry compare on Recompute).
- **Parts tree virtualization** — `QTreeView` + `QAbstractItemModel` for large kits (5k+ rows); collapse-all when >500 parts with summary hint.
- **ProfileComposer mixins** — `export_actions.py` and `checkoff_actions.py` extracted from the composer hub.

### Changed

- **License docs** — [PolyForm Noncommercial 1.0.0](LICENSE) with [LICENSE-SUMMARY.md](LICENSE-SUMMARY.md) and the former `COMMERCIAL.md`; Help menu entries for overview and full license text.
- **Workflow guide** — manifest curation and fast recompute documented; duplicate Recompute control removed from layers panel (header + Ctrl+R remain).
- **GitHub Pages** — static landing at `docs/index.html` deployed via `pages.yml`.

### Fixed

- Build wizard addon navigation guards invalid `nextId` transitions.

## [0.3.1] - 2026-05-24

### Added

- **Custom filaments** — Named colors in a local library; export/import library JSON; bundled in shared kit exports.
- **Repo list sharing** — Export/import repository list JSON (Libraries → More).
- **Print: assign folder** — Select a repo/folder row and assign all parts to a printer; 3MF plates group and name by filament · repo · folder.
- **Ko-fi support** — Optional tip link in workflow bar and Help menu; Support section in README.
- **Checkoff print tracking** — Per-unit printed counts save to the kit; filter all/missing/done; **Print missing →** loads unfinished units on the Print tab; **Export missing 3MF…** for slicer plates; in-tab guide for exports.

### Changed

- **Libraries / Kit / Print / Checkoff UI** — Clearer step guides, tooltips, wider readable columns, simplified part filters, tighter checkoff layout, and checkoff export help copy.
- **License & notices** — Non-commercial license, third-party notices, in-app Help entries, bundled in release builds.

### Fixed

- Circular import in plate packer when grouping plates by location.

## [0.3.0] - 2026-05-24

### Added

- **3MF export** — Multi-printer **Print** tab: fleet bed sizes, loaded filament per machine, manual assign from an unclassified pool to printers, auto-assign by filament, bin-pack per plate; export per-plate `.3mf`, zip, or single-file modes.
- **Printer fleet** — Presets, bed sizes, loaded spool slots; persisted per kit print plan.
- **Release automation** — Reusable GitHub Actions build workflow, version/CHANGELOG gates, **Release (create tag)** dispatch, CHANGELOG-based release notes.
- **Workflow guide** — Numbered workflow strip with gating, breadcrumbs, status bar, and onboarding copy.
- **Industrial UI polish** — Palette-aware light/dark styling, banners, consolidated toolbars, richer parts/repo trees.

### Changed

- **Kit Compose** — Removed suggestions panel from compose flow; parts summary in toolbar.
- **Print tab** — Two-panel assign UI (unclassified ↔ printers) instead of nested plate tree editor.

### Fixed

- Theme text contrast in dark mode (palette-based QSS instead of hardcoded grays).
- CI: Ruff import/unused fixes; repo import dialog test reads UTF-8 on Linux.

## [0.2.0] - 2026-05-23

### Added

- **Kit sharing** — Export/import `.print-partner-kit.zip` bundles (layers, parts, filament, notes; no print progress).
- **AI assistant** (optional) — OpenAI/Anthropic-compatible chat, suggestions review, and offline heuristics panel on Kit Compose.
- **Workflow strip** — Libraries → Kit (Compose / Review) → Checkoff navigation with keyboard shortcuts (Ctrl+1/2/3, Ctrl+R, F1).
- **Toasts** and inline banners replacing many success modal dialogs.
- **First-run dialog**, path picker, remote sync chip, kit library empty states, and profile suggestions panel.
- **Structured logging** (`logging_setup`) across workers and CLIs.
- **Formal DB migrations** (`schema_version` in app settings, ordered `SCHEMA_MIGRATIONS`).
- **CI** — Full-repo ruff, pytest on Ubuntu/macOS (3.11/3.12), Windows (3.11); release workflow for tagged builds.
- **Packaging** — DMG/notarize scripts, artifact packaging, macOS NumPy verification, release smoke-test doc.
- **Docs** — `docs/ARCHITECTURE.md`, release README, thumbnail/bundle notes.

### Changed

- **Checkoff & HTML export** — Print-optimized letter layout: document header, filament color swatch on each part row (tooltip for full name), wider Print/Verify columns, solid thumbnails with outer outline only (`THUMB_CACHE_VERSION` v3).
- **Checkoff UI** — Theme-aware styling (palette colors for light/dark mode); removed progress summary bar and filament legend.
- **Profile composer** — Split into `ui/composer/` mixins; main window uses stacked content (no widget reparenting).
- **Python** — `requires-python >= 3.11`; expanded ruff configuration.

### Fixed

- Kit list **Duplicate** now prompts for a name.
- Datetime handling uses `timezone.utc` for broader compatibility.
- Various import/sync and test coverage improvements.

## [0.1.0] - 2025

### Added

- Initial release: GitHub STL libraries, layered kits, merge engine, PySide6 UI, HTML export, SQLite persistence, Source–Build–Verify–Checkoff workflow.

[0.3.0]: https://github.com/poitee/PrintPartner/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/poitee/PrintPartner/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/poitee/PrintPartner/releases/tag/v0.1.0
[3.1.0]: https://github.com/poitee/PrintPartner/compare/v3.0.0...v3.1.0
[Unreleased]: https://github.com/poitee/PrintPartner/compare/v3.3.0...HEAD
[3.2.0]: https://github.com/poitee/PrintPartner/releases/tag/v3.2.0
[3.3.0]: https://github.com/poitee/PrintPartner/releases/tag/v3.3.0
