# PrintPartner health audit — 2026-09-26

**Scope:** read-only audit of `poitee/PrintPartner` at `main` (`90d2ee8`, merge of #88; also includes #81/#82).  
**Method:** `npm run audit:cleanup`, `npx depcheck`, `npx knip`, `npm outdated`, `npm audit`, `gh` workflow/PR history, Linear/parked-feature greps with import tracing, and a full local quality run on this commit.  
**Non-goals:** no product code changes; this document is the only deliverable.

---

## Executive summary

Main at `90d2ee8` is healthy on the gates that matter: lint, typecheck, unit/integration tests, workflow smoke, production build, runtime checks, browser scripts, high-severity `npm audit`, and manifest validation all passed locally in ~4.5 minutes (excluding Docker image builds). GitHub Web CI for the three just-merged PRs (#81/#82/#88) also succeeded on `main` (~9–11 minutes each). The biggest verified dead weight is the post–GRE-225 in-app Kit Advisor chat stack (`tool-loop`, text-tool parsers, web chat client wrappers) while MCP + build-planning remain live. Parked ideas GRE-205–208, shop bins, auto-parser, and SaaS site-agent left little or no application code. Kitchen-sink leftovers are mixed: Build Tracking, Spoolman auto-deduct, Prometheus, PWA, Discord digest, SaaS/Postgres, and the Orca slicer sidecar are still wired; Redis/BullMQ and SearxNG are documentation or alias leftovers. CI pain is dominated by a heavy sequential `web`→`docker` gate (~10+ min), an `npm audit --audit-level=high` step that can fail PRs for transitive advisories unrelated to the diff, and occasional OrcaSlicer sidecar Docker cold builds (~17 min). Cursor Bugbot still registers a neutral check on PRs despite not being wanted; CodeRabbit is the intended review gate and is active. Open Dependabot PRs #93–#97 landed during this audit. Debloat should start with safe chat-orphan and docs cleanup, then optional Home Assistant / legacy `/slice`, then larger structural wins (repository split, Docker runtime slim).

---

## 1. Obsolete / dead code

Tooling used: `cd web && npm run audit:cleanup` (1,565 files, 0 broken Markdown targets, 5 zero-inbound sources, 7 intentional duplicate groups), `npx depcheck`, `npx knip`, and import tracing.

### 1.1 Parked features (owner: permanently parked)

| Item | Code footprint | Verdict |
|------|----------------|---------|
| **GRE-205** Bambu Fleet Hub / Local Server send | Comment only in `web/apps/server/src/integrations/adapters/bambu.ts` (~411): “Intentionally no uploadFile… Connect-Local Server.” Live path is Bambu Connect handoff + LAN MQTT status. | **No SDK code to delete** |
| **GRE-206** SaaS site-agent | **0** matches for `site-agent` / `site_agent` | **Never landed** |
| **GRE-207** AMS/MMU slot mapping | No AMS/MMU symbols; only generic `max_filament_slots` / `filament_slots` | **Never landed** |
| **GRE-208** GHCR publish | Release/ops tracking, not app code (`scripts/release.mjs`, `.github/workflows/release.yml`) | **N/A** |
| **Shop bins** | **0** matches; bag/sort bars shipped instead (`ProgressBagBarRow.tsx`) | **Never landed** |
| **Auto-parser** | **0** `auto-parser` / `AutoParser`; live alternative is `repo-tree-summary` + MCP `inspect_repo_tree` | **Never landed** |
| **Kit Advisor training** | No fine-tuning pipeline; curated domain pack under `web/apps/server/src/data/assistant-domain/` and `domain-pack.ts`. Contracts note examples are “not model training.” | **No training code** |
| **Fake slicer / Flask orca-slicer sidecar** | `slicer-sidecar/` is a **real** Compose/CI integration (Flask+Waitress wrapping Orca CLI). “Fake slicer” appears only as **test fixtures** in `test_sidecar.py`. | **Keep** (wired); see legacy `/slice` below |

### 1.2 Confirmed dead (verified)

| Artifact | Evidence | ~Lines |
|----------|----------|--------|
| `POST /assistant/chat` | Always **410 Gone** in `web/apps/server/src/routes/assistant.ts` (~286–295); covered by `assistant-routes.test.ts` | route stub |
| `tool-loop.ts` (`runAssistantTurn`) | Imported only by `tool-loop-*.test.ts` and `golden-eval.test.ts` — **no production caller** | 816 + ~515 tests |
| `parse-text-tool-calls.ts`, `recover-proposals-from-text.ts` | Only consumed by `tool-loop.ts` (+ their tests) | ~621 + tests |
| `buildAssistantSystemPrompt` | Only `assistant-context.test.ts` + `tools.test.ts` | part of `assistant-context.ts` (351) |
| Web chat client API | `postAssistantChat`, `streamAssistantChat`, `fetchAssistantHistory`, `applyAssistantAction`, `fetchAssistantStatus`, feedback helpers in `web/apps/web/src/api/endpoints/assistant.ts` — **no** `pages/` or `components/` imports. Live use from that file: **`fetchPlanDecisions`** via `queries/planRecipe.ts`. Still re-exported from `engine.ts`. | 194 (mostly dead) |
| `appendAssistantHistory` | Only `history-pending.test.ts` writes history after chat removal. `GET/DELETE /assistant/history` remain but stay empty in normal use. Feedback helpers in `history.ts` are still used by MCP/domain scoring. | partial of 365 |
| `checkDailyBudget` / `recordDailyUsage` | Only `usage.test.ts`; budgets not enforced without chat. `loadDailyUsage` still read by `/assistant/status`. | partial of 113 |
| `GET /assistant/status` | Hard-codes `enabled: false` (`assistant.ts` ~60) | live stub |
| `capture-digest-fixtures.ts` | Zero inbound (`audit:cleanup` + knip) | 233 |
| `mcp/try-build-planning.ts` | Zero inbound; MCP demo harness | 156 |
| **REDIS_URL / BullMQ** | Documented in `web/DEPLOY.md`, `CHANGELOG.md`; **no** `bullmq` dependency or `REDIS_URL` readers under server. Rate limit uses `redis: undefined` in `app.ts` (~261). | docs only |
| **SearxNG** | `resolve-assistant.ts` maps `search_provider: "searxng"` → `duckduckgo` (compat alias); tests only | ~alias |

Zero-inbound sources from `audit:cleanup` (intentional entrypoints marked):

- `.cursor/skills/verify-print-partner/helpers/control-print-partner.mjs` — skill helper
- `web/apps/server/src/db/migrate.ts` — CLI entry (`db:migrate`)
- `web/apps/server/src/mcp/stdio-server.ts` — MCP stdio entry
- `web/apps/server/capture-digest-fixtures.ts` — **dead manual script**
- `web/apps/server/src/mcp/try-build-planning.ts` — **dead demo harness**

Knip also listed unused **manual** scripts under `web/scripts/` (not in CI `quality`): `check-manual-printers.mjs`, `check-plan-quantities.mjs`, `checkoff-all-copies.browser.mjs`, `checkoff-sort.browser.mjs`, `design-system-contrast.mjs`, `generate-pwa-icons.mjs`, `import-sqlite.ts`, `plan-save-benchmark.mts` (~660 lines combined). These are operator tools, not runtime dead code; optional archive/delete.

### 1.3 Still wired (kitchen-sink status)

| Item | Status | Evidence |
|------|--------|----------|
| **Build Tracking** | **Wired** | Settings API + UI; Checkoff uses `assembly_tracking` |
| **Discord digest** | **Wired** (self-host) | `routes/discord-digest.ts`, `core-routes.ts`; denied on hosted (`hosted-planning-deny.ts`) |
| **Home Assistant** | **Optional / API-only** | Adapter registered in `integrations/registry.ts`; **no** Settings UI (Spoolman only in `IntegrationsSettingsCard.tsx`); ~377 + 381 test lines |
| **Spoolman auto-deduct** | **Wired** | `services/spoolman-deduct.ts` called from `printer-checkoff.ts` on verify |
| **PWA / service worker** | **Wired** | `main.tsx` → `registerServiceWorker.ts`; `public/sw.js`; `PwaInstallBanner` on Checkoff; behavior tests |
| **SearxNG** | **Dead** (alias) | See §1.2 |
| **Redis rate limits** | **Dead in code** | In-memory `@fastify/rate-limit` only |
| **Prometheus** | **Wired** | `routes/metrics.ts` (~290 lines), registered in `app.ts`; `OPERATIONS.md` |
| **SaaS / Postgres** | **Wired** | `DEPLOY_MODE=saas`, `client-postgres.ts`, `docker-compose.saas.yml` / `hosted.yml`; CI compose validation + optional Postgres smoke |
| **Slicer sidecar** | **Wired** | Compose (`pp-compose.yml`), CI Docker build, `slicer-sidecar.ts` prefers `/v1/slice` then falls back to legacy `/slice` in Flask `sidecar.py` |
| **Kit Advisor (MCP)** | **Live** | `assistant/tools.ts` (~5,875 lines) + `mcp/`; in-app chat removed (GRE-225) |

### 1.4 Large / tangled modules (not dead, but debloat-relevant)

| Path | Lines | Note |
|------|------:|------|
| `web/apps/server/src/db/repository.ts` | 8,502 | God-object repository; 63 exports |
| `web/apps/server/src/assistant/tools.ts` | 5,875 | Live MCP tool surface |
| `web/apps/server/src/db/schema.ts` | 2,859 | Dual with `schema-pg.ts` (1,174) — config sprawl / drift risk |
| `web/apps/web/src/pages/SourcesPage.tsx` | 1,487 | Largest SPA page |
| `web/apps/server/src/routes/printer-checkoff.ts` | 1,563 | Core Checkoff route |
| `web/apps/server/src/routes/jobs.ts` | 1,313 | Includes STL pack export |
| `web/apps/server/src/services/export-stl-pack.ts` | ~680 | Covered via `accepted-stl-bundle.test.ts` + smoke, no dedicated `export-stl-pack.test.ts` |

TODO/FIXME/HACK/XXX in TS/JS/Python product sources: **0** matches (clean hotspot signal).

---

## 2. CI / checks

### 2.1 Workflow inventory

| Workflow | File | Jobs | Role |
|----------|------|------|------|
| **Web CI** | `.github/workflows/web-ci.yml` | `web` → `docker` | Primary merge gate |
| **Optional integration smoke** | `integration-smoke.yml` | `postgres` (always on path match); `slicer-sidecar` (manual dispatch only) | Extra SaaS/Postgres |
| **Validate manifests** | `validate-manifests.yml` | `schema` | Manifest + embedded-copy drift |
| **Release** | `release.yml` | Reuses Web CI + manifests, then GHCR | Tag `v*.*.*` only |
| **pages** | `pages.yml` | `deploy` | Landing page to GitHub Pages |

**Local hooks:** none (no `.pre-commit-config.yaml`, husky, or lefthook). Gate is `cd web && npm run quality`.

**Required checks** (from `.agents/skills/autopilot/references/printpartner-ci.md`; branch protection API returned **403** to this token; rulesets list was empty):

- Web CI / `web`
- Web CI / `docker`
- Validate manifests / `schema` (when that workflow runs)

### 2.2 What `web` runs vs `quality`

`npm run quality` = lint → typecheck → test → workflow-smoke → build → test:runtime → test:browser.

CI `web` additionally runs **`npm audit --audit-level=high` before quality** (not part of the `quality` script).

CI `docker` (after `web`): compose config for all compose files → `docker build` app → startup smoke → **OrcaSlicer sidecar image build** → container health → `web/scripts/workflow-smoke.sh`.

**Redundancy:** production `npm run build` inside quality, then another image build in `docker`; Python `test:workflow-smoke` plus shell API smoke against a container.

### 2.3 Bots

| Bot | Repo config | Live on PRs | Wanted? |
|-----|-------------|-------------|---------|
| **CodeRabbit** | No `.coderabbit.yaml` (org/app level) | Commit status `CodeRabbit` (e.g. “Review completed” on #83; “reviews are disabled for this base branch” success-skip on #85) | **Yes** — intended PR gate |
| **Cursor Bugbot** | No in-repo config | Check `Cursor Bugbot` = **NEUTRAL** / skipping on #83/#85/#91 | **No** — still appears in the checks list |

### 2.4 Recent history: flakiness, slowness, PR noise

**Main after today’s merges:** Web CI succeeded for #81/#82/#88 ([36218429662](https://github.com/poitee/PrintPartner/actions/runs/36218429662), [36218440851](https://github.com/poitee/PrintPartner/actions/runs/36218440851), [36218450790](https://github.com/poitee/PrintPartner/actions/runs/36218450790), ~9–11 min). Optional Postgres smoke also green (~1.3 min).

**Concrete failure modes (recent):**

| Issue | Evidence | Why it hurts |
|-------|----------|--------------|
| **`npm audit --audit-level=high` fails before tests** | Main after #76: [35606089251](https://github.com/poitee/PrintPartner/actions/runs/35606089251) (~51s, audit only); fixed by #78 | Blocks PRs/main for **transitive advisories**, not the PR’s code |
| **Brittle byte-cap assertion** | [36039472194](https://github.com/poitee/PrintPartner/actions/runs/36039472194): `printer-checkoff-progress.test.ts` — `expected 285212672 to be less than or equal to 276824064` (same failure also hit DNS PR [36039403873](https://github.com/poitee/PrintPartner/actions/runs/36039403873)) | Stacked/shared branches fail for **unrelated** upload-limit math |
| **Source cover cache assertion** | [36033451334](https://github.com/poitee/PrintPartner/actions/runs/36033451334): `source-cover.test.ts` expected cache path, got `null` | Looks like env/order flakiness |
| **Browser journey failure** | [35620699782](https://github.com/poitee/PrintPartner/actions/runs/35620699782): “Part color browser journey failed” | Occasional WebGL/browser flake after vitest |
| **OrcaSlicer sidecar cold build** | Success outlier [36040139039](https://github.com/poitee/PrintPartner/actions/runs/36040139039): `docker` job ~19 min (vs ~2.5 min typical) | Wall-clock variance without layer cache; PR stays yellow |
| **No concurrency group on Web CI** | Duplicate runs on same branch (e.g. library-navigation-guard runs 36053274306 + 36053977213) | Wastes minutes; merge UI churn |
| **Sequential `web` then `docker`** | Typical green ~9–10 min ([36052213520](https://github.com/poitee/PrintPartner/actions/runs/36052213520): web ~6.5 min, docker ~2.5 min) | `mergeStateStatus: UNSTABLE` until both finish |

**Open stacked PRs (audit snapshot, then refresh):**

| PR | Notes |
|----|-------|
| **#83** | `web`+`docker` green; CodeRabbit success; Bugbot neutral → **CLEAN** |
| **#85** | Checks green; mergeability briefly UNKNOWN; Bugbot neutral |
| **#91** | **DIRTY** (conflicts with `main`) — blocked by rebase, not CI alone; Bugbot neutral |
| **#80** (draft Sentry) | `web`+`docker` green; draft skips CodeRabbit |

**What makes PRs look unstable/blocked:** pending sequential `docker`, optional `postgres` row, Bugbot neutral row, CodeRabbit pending/skip, and real merge conflicts (#91). Autopilot tests already treat `UNSTABLE` as often “non-required still pending.”

---

## 3. Dependencies

### 3.1 Audit / Dependabot

| Signal | Result |
|--------|--------|
| `npm audit` (full + `--omit=dev`) | **0 vulnerabilities** at `90d2ee8` |
| GitHub Dependabot vulnerability alerts API | Enabled; **0 open alerts** at audit time |
| Open Dependabot PRs | **#93–#97** opened 2026-09-26 during this audit (multipart, typescript-eslint, aws-sdk, three, react-query) |
| Dependabot config | `.github/dependabot.yml`: weekly npm/pip/actions/docker; **majors ignored** for npm + Docker |

### 3.2 Unused / hygiene

| Finding | Evidence | Risk |
|---------|----------|------|
| Root `web/package.json` **`fastify`** devDependency unused | depcheck + knip; server/web already declare it | **Low** — remove |
| Missing declared tooling deps for root scripts | depcheck: `typescript`, `playwright-core`, `pg`, `@print-partner/contracts` used under `web/scripts/` | **Low** — declare or hoist |
| Web `zod` / `fflate` unlisted | knip: used in FilenameGrouping + browser tests | **Low** — declare |
| `docs/scripts` Playwright | No lockfile; can drift from `playwright-core` 1.62.x in web | **Low** |

### 3.3 Outdated

- **37** outdated entries (`npm outdated`).
- **25** in-range patch/minor updates available (e.g. `@aws-sdk/client-s3`, `react` 19.2.8→19.3.0, `zod` 4.5.4→4.6.5) — partially covered by open Dependabot PRs.
- **Majors available (blocked by Dependabot ignore):** `@fastify/compress` 8→9, `better-sqlite3` 12→13, `chokidar` 4→5, `nodemailer` 9→10, `@types/better-sqlite3` 7→9. Also `vitest` 4→5 / `typescript` 6→7 show as latest in broader scans — treat as high-effort upgrades, not routine Dependabot.

### 3.4 Duplication / weight

- **Five zip/archive libraries:** `fflate`, `jszip`, `adm-zip`, `yazl`, `tar` (intentional roles, but consolidation candidates).
- **~48** transitive multi-version packages in the lockfile (`@types/node`, `lightningcss`, `ajv`, …).
- Heavy prod install surface: `pdf-parse`→`pdfjs-dist`, `@aws-sdk/client-s3`, `dockerode`, `mqtt`, `three`, `lucide-react`, MCP SDK — mostly feature-justified; biggest **image** win is not shipping SPA `node_modules` into the server runtime stage (Dockerfile copies full `/app/web` after workspace `npm ci --omit=dev`; probe ≈477 MB `node_modules`).
- Slicer sidecar `FROM lscr.io/linuxserver/orcaslicer:…` is a **GUI-sized** base for CLI-only use — high effort to slim.

### 3.5 Python

- `manifests/requirements.txt`: `jsonschema==4.26.0`, `PyYAML==6.0.3` — current; OSV clean; 15/15 validator tests passed locally.
- Sidecar pins Flask 3.1.3 + Waitress 3.0.2 in Dockerfile only (no requirements.txt).

---

## 4. Overall health

### 4.1 Gates run on `90d2ee8` (this audit VM)

| Gate | Result | Notes |
|------|--------|-------|
| `npm ci` | Pass | 734 packages, 0 vulns |
| `npm run lint` | Pass | |
| `npm run typecheck` | Pass | |
| `npm test` | Pass | Release/scripts 38+7; contracts **101**; domain **144**; web **1,370** (259 files); server **2,194** (271 files) |
| `npm run test:workflow-smoke` | Pass | 12/12 |
| `npm run build` | Pass | |
| `npm run test:runtime` | Pass | 2/2 |
| `npm run test:browser` | Pass | CI browser set |
| `npm audit --audit-level=high` | Pass | 0 |
| Manifests unittest | Pass | 15/15 |
| Sidecar unittest | Pass (after `pip install flask==3.1.3`) | 8/8; first attempt failed only due to missing Flask in the bare VM |
| `npm run audit:cleanup` | Pass | 0 broken links |
| GitHub Web CI on main for #81/#82/#88 | Pass | ~9–11 min |

Wall clock for local quality chain (lint→browser, no Docker): **~4.5 minutes** (04:45:28–04:49:50 UTC).

### 4.2 Coverage gaps on core flows

| Flow | Coverage signal | Gap |
|------|-----------------|-----|
| **Plan** | Very strong: many `plan-drafts`, `accepted-plan-*`, publication, freshness, summary tests | Continues to grow; risk is **complexity**, not absence |
| **Checkoff** | Strong: `printer-checkoff*.test.ts`, many `checkoffConsole*` web tests | Largest brittle CI failure recently was upload byte-cap in `printer-checkoff-progress.test.ts` |
| **Sources / Library** | Strong server source-revision tests; SPA has focused SourcesPage tests (~3 files) vs **1,487-line** page | UI regression surface larger than page-level tests; stacked PRs #83/#91 address autosave |
| **STL export** | `accepted-stl-bundle.test.ts`, `phase3` message tests, workflow smoke `POST /jobs/export-stl-pack` | No dedicated `export-stl-pack.test.ts` for the ~680-line service |
| **Build planning** | `build-planning.test.ts` (585) + routes + `BuildPlanningCard` tests; #81 just tightened draft invalidation | Solid; `try-build-planning.ts` is orphan demo only |
| **Browser E2E** | `test:browser` runs 7 scripts | **Not in CI package script:** `reference-sharing.browser.mjs`, `workflow-cleanup.browser.mjs`, non-isolated `filename-grouping.browser.mjs` / `part-color.browser.mjs` |

### 4.3 Config / Docker sprawl

Compose surface: `docker-compose.yml`, `docker-compose.saas.yml`, `docker-compose.hosted.yml`, `pp-compose.yml`, plus verify helper compose under `.cursor/skills/…`. Schema dual-maintenance (`schema.ts` vs `schema-pg.ts`, both `currentSchemaVersion = 34`). Docs still advertise Redis/BullMQ that are not implemented. Hosted deny list centralizes feature cutouts (`hosted-planning-deny.ts`) — good, but increases “feature exists in tree but disabled” surface.

### 4.4 Duplicate logic / structure

- Accepted-plan / accepted-plate modules are numerous (`db/accepted-plan*`, `services/accepted-*`) — intentional layering, but high cognitive load.
- Zip libraries overlap (§3.4).
- Assistant directory mixes **live MCP tools** with **dead chat loop** (~12k non-test lines under `assistant/`).

---

## 5. Ranked debloat plan (PR-sized chunks)

Effort is relative (S/M/L). Risk is product/regression risk. Line/deps estimates are approximate from this audit’s counts.

### Chunk A — Dead chat client + orphan scripts (approve first)

| | |
|--|--|
| **Risk** | Low |
| **Effort** | S |
| **Removes** | ~400–600 lines client/scripts; 0 runtime deps |
| **Do** | Keep `fetchPlanDecisions` (move to `planSnapshots`/`planRecipe` endpoints if cleaner). Delete unused chat exports from `endpoints/assistant.ts` + `engine.ts` re-exports. Delete `capture-digest-fixtures.ts`, `try-build-planning.ts`. Optionally archive knip-listed manual `web/scripts/*` not referenced by docs/skills. |
| **Verify** | `npm run test -w @print-partner/web`; `audit:cleanup` |

### Chunk B — Server chat-loop stack

| | |
|--|--|
| **Risk** | Low–med (tests encode behavior; relocate golden-eval to MCP-focused tests first) |
| **Effort** | M |
| **Removes** | ~1,900+ lines (`tool-loop*` + parsers + golden-eval + related) |
| **Do** | Delete `tool-loop.ts` and dedicated tests after porting any still-valuable assertions onto MCP/`tools.ts` tests. Delete `parse-text-tool-calls*`, `recover-proposals-from-text*`. Trim `buildAssistantSystemPrompt` if unused by MCP. |
| **Keep** | `tools.ts`, LLM adapters used by MCP/guide-ingest/build-decisions, domain pack |
| **Verify** | Full server vitest + MCP route tests |

### Chunk C — Chat history HTTP + usage writers

| | |
|--|--|
| **Risk** | Med (unknown external HTTP clients) |
| **Effort** | S |
| **Removes** | History routes + dead writers; keep feedback scoring exports used by MCP |
| **Do** | Remove or 410 `GET/DELETE /assistant/history` and `appendAssistantHistory` path; simplify `/assistant/status` budgets if unused; delete `recordDailyUsage`/`checkDailyBudget` if status no longer needs them. Document MCP as sole assistant surface. |
| **Verify** | `assistant-routes.test.ts`; public API note in `docs/API.md` |

### Chunk D — Docs / alias honesty

| | |
|--|--|
| **Risk** | Low |
| **Effort** | S |
| **Removes** | Docs drift only; optional searxng alias |
| **Do** | Strip Redis/BullMQ claims from `web/DEPLOY.md` / `CHANGELOG.md` (or mark “not implemented”). Remove `searxng`→duckduckgo mapping if no persisted integrations use it (grep DB + tests). |
| **Verify** | Docs tests / `site-map-docs.test.mjs` |

### Chunk E — Home Assistant adapter (optional product cut)

| | |
|--|--|
| **Risk** | Med (API-only deployments may exist) |
| **Effort** | S–M |
| **Removes** | ~760 lines + contract type + hosted LAN list entry |
| **Do** | Confirm no production `home_assistant` integrations; remove adapter, registry entry, contracts union, tests. |
| **Verify** | Integration registry tests; hosted-planning contracts |

### Chunk F — Legacy sidecar `/slice` path

| | |
|--|--|
| **Risk** | Med (self-hosters on old sidecar images) |
| **Effort** | M |
| **Removes** | Legacy branch in `slicer-sidecar.ts` + Flask `/slice` if all images speak `/v1/slice` |
| **Do** | Ship one release that logs deprecation; next release delete fallback. Keep Docker sidecar build in CI. |
| **Verify** | Sidecar tests; docker job; integration adapter tests |

### Chunk G — CI cost / stability (no product delete)

| | |
|--|--|
| **Risk** | Low–med (workflow changes) |
| **Effort** | M |
| **Removes** | Minutes/queue, not LOC |
| **Do** | (1) GHA cache for `slicer-sidecar` Docker layers. (2) Concurrency group on Web CI cancel-in-progress for PR branches. (3) Soften or isolate brittle assertions (`printer-checkoff-progress` byte cap; `source-cover` cache). (4) Disable **Cursor Bugbot** at org/repo app settings (not in-tree). (5) Consider moving `npm audit` to a non-required or scheduled job so Dependabot/advisory PRs own the fix. |
| **Verify** | Sample PR wall-clock; required-check list in GitHub settings |

### Chunk H — Dependabot batch

| | |
|--|--|
| **Risk** | Low (patch/minor) |
| **Effort** | S |
| **Removes** | Outdated surface |
| **Do** | Land open #93–#97 (and weekly follow-ons). Defer majors (`better-sqlite3` 13, `vitest` 5, `typescript` 7). |
| **Verify** | Web CI + `npm audit` |

### Chunk I — Docker runtime slim

| | |
|--|--|
| **Risk** | Med |
| **Effort** | L |
| **Removes** | Likely 100MB+ from GHCR image (SPA-only packages out of runtime stage) |
| **Do** | Multi-stage: build web → copy `apps/web/dist` only; production `node_modules` scoped to server+domain+contracts. Optional dynamic import for `@aws-sdk` / `pdf-parse` on self-host. |
| **Verify** | `docker` job + startup smoke |

### Chunk J — Structural (later)

| | |
|--|--|
| **Risk** | High |
| **Effort** | L |
| **Do** | Split `repository.ts`; thin `SourcesPage.tsx`; optional zip-lib consolidation; dedicated `export-stl-pack` unit tests; consider whether Prometheus/Discord digest/PWA remain in default self-host profile or become opt-in packages. |
| **Verify** | Full `quality` + docker |

### Suggested approval order

1. **A** → **D** → **H** (safe, immediate clarity)  
2. **B** → **C** (largest dead chat deletion)  
3. **G** (CI experience for stacked PRs)  
4. **E** / **F** (optional product cuts — owner call)  
5. **I** → **J** (structural / image)

---

## Appendix — evidence commands

```sh
git rev-parse HEAD   # 90d2ee81a3352bf04fac0db2e8f7ea84a0ec7d7b
cd web && npm ci && npm run lint && npm run typecheck && npm test \
  && npm run test:workflow-smoke && npm run build && npm run test:runtime \
  && PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome npm run test:browser \
  && npm audit --audit-level=high && npm run audit:cleanup
python3 -m unittest manifests.tests.test_validate
cd slicer-sidecar && python3 -m unittest -v test_sidecar.py   # needs flask
npx --yes depcheck --json
npx --yes knip --reporter compact
npm outdated
gh run list --workflow "Web CI" --limit 25
gh pr list --author app/dependabot --state open
```

---

*Audit completed 2026-09-26 UTC. Product code unchanged.*
