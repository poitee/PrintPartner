# Codebase rehabilitation audit, 2026-09-04

## Verdict

PrintPartner is materially safer, more coherent, and easier to operate than the audited 2026-08-31 state. This pass fixed confirmed defects across storage, concurrency, authentication, remote I/O, Source handling, manifests, printer integrations, UI recovery, and build tooling.

Of the 16 findings in the [full site audit](./2026-08-31-full-site-audit.md), 11 are closed and 5 are mitigated. No prior finding was left untouched. The remaining limits are listed explicitly below.

This is a verified rehabilitation, not a claim that any codebase can be permanently perfect. For current supported paths, the completion standard was no known critical or high-impact defect, clean project gates from a fresh install, user-level runtime proof, and a durable record of residual limits. The historically affected v3.3 multi-user tenant cohort is bounded separately under Known limits.

## Method

The audit covered the repository in parallel slices, then ranked findings by data loss, security, cross-tenant exposure, resource exhaustion, and user-visible failure risk. Each accepted code defect received a focused reproduction or regression test before the repair when a useful seam existed. The final review included the active diff, the prior audit, cleanup and public-release audits, dependency resolution, package tests, Python validators, production builds, API health, and browser behavior.

The review treated external input and durable state as system boundaries. It therefore concentrated validation and limits at HTTP, OAuth, printer, sidecar, archive, filesystem, database, and package-publication seams instead of distributing defensive checks through trusted internal code.

## Prior audit closure

| Finding | Status | Current result | Remaining limit |
| --- | --- | --- | --- |
| Source history and backups have no storage lifecycle | Mitigated | In SQLite self-host deployments, [storage inventory](../../web/apps/server/src/services/storage-inventory.ts) reports category usage and estimates uncompressed full-backup content. [Backup scope](../../web/apps/server/src/services/backup-scope.ts) enumerates the covered roots. Settings exposes the estimate and free space. | There is no content-addressed deduplication, revision or export retention, quota, automatic backup retention, or preserve-forever policy. PostgreSQL and S3 require their native backup tools. |
| Live restore is not transaction-safe and needs excess disk | Mitigated | SQLite self-host [restore](../../web/apps/server/src/services/backup-restore.ts) validates archive structure and SQLite integrity, preflights free space, stages each replacement beside its live root on the same filesystem, activates with renames, rolls back in reverse order, and reconnects SQLite. A second in-process restore is rejected. | There is no whole-app maintenance gate, mutation drain, distributed lock, or crash journal. Multiple roots switch sequentially. Free-space data is point-in-time, and live roots are not captured as one consistent snapshot. PostgreSQL and S3 are outside this facility. |
| Upload boundaries permit memory or disk exhaustion | Mitigated | [Central upload limits](../../web/apps/server/src/services/upload-limits.ts) replace unlimited defaults. Route-specific budgets, unexpected-file draining, and cleanup cover Source, import, backup, Bambu, part, Checkoff, assistant, and MCP requests. Kit imports cap logical JSON at 16 MiB before or immediately after expansion, and local-path imports reject files above 64 MiB before reading them. | Fastify still buffers ordinary JSON up to 16 MiB and assistant or MCP action bodies up to 384 MiB. Several bounded upload paths also concatenate chunks before processing. Source archives can expand to 1 GiB on disk, and each nested 3MF package is read synchronously before its inner model-document limit is applied. A backup upload may consume up to 20 GiB on disk. Limits are not quotas or space reservations. |
| Source monitoring skips non-default tenants | Closed | [Source watcher coordination](../../web/apps/server/src/services/source-watcher.ts) enumerates authenticated tenants and executes each run in explicit tenant context. The last-check timestamp is persisted and displayed. | Detailed per-tenant outcomes and error text are not persisted or displayed. |
| Source intervals are unsafe and checks can overlap | Closed | Persisted values accept only disabled or whole hours from 1 through 168. Duplicate phases coalesce, distinct startup and scheduled phases queue, and tenants run serially. | Coordination is process-local. Multiple server processes do not share a scheduler lease, and shutdown does not drain active watcher work. |
| Plan and printer load failures lack recovery | Closed | Plan and Printers expose retry actions. Printers preserves stale data and no longer renders a false empty state after a transient failure. | None identified in this scope. |
| All Production counts become stale after printer events | Closed | Printer and Checkoff events refresh both farm state and Build summaries. Completing a past-print Checkoff refreshes those summaries directly. | The refresh is broad rather than an affected-Build domain event. |
| Settings contains unnamed controls | Mitigated | Slicer, filament, and workflow controls now have stable accessible names or label associations. | Some add-slicer, editable-name, and custom-filament name and color fields use accessible names rather than persistent visible labels. |
| Builds has undersized mobile links | Closed | Checkoff and Production links now expose a 44 px minimum target in cards and table rows. | None identified in this scope. |
| Printer polling can overlap | Closed | [Shared printer queries](../../web/apps/web/src/queries/printerStatuses.ts) deduplicate observers, prevent interval overlap, isolate host failures, reuse cache state, and pause background polling. | Polling uses a fixed cadence rather than backoff or printer events. |
| Bambu handoffs lack retention | Closed | [Transfer retention](../../web/apps/server/src/services/transfer-artifact-retention.ts) deletes terminal completed and failed artifacts, sweeps old unreferenced handoffs and orphan uploads, and preserves queued work until it reaches a terminal state. | Sweeping is best effort. A crash can leave an artifact until the next startup or request sweep. |
| Shared-package rebuild can kill the development API | Closed | [Atomic package publication](../../web/scripts/atomic-package-build.mjs) builds a complete staged release and moves one current pointer. Development imports TypeScript source. | A crashed publisher leaves a fail-closed lock for manual cleanup. Windows junction replacement has a brief remove-and-replace interval. |
| Loading messages are not consistently announced | Mitigated | Source Library, Plan data loading, and All Production data loading use status semantics in the repaired paths. | Engine connection messages remain unannounced on Parts and All Production, and there is no shared asynchronous-status component. |
| Source detail context is local state | Closed | Source, detail tab, and highlighted file are URL-owned through `source`, `tab`, and `file` parameters. | Bulk checkbox selection remains intentionally ephemeral. |
| Uncategorized and Uncategorised are mixed | Closed | User-facing Source Library text consistently uses `Uncategorised`. | The internal compatibility sentinel retains its American-spelled identifier. |
| Vite serves JSON for a dynamic studio navigation | Closed | Vite recognizes `/plans/:id/studio` document navigation while preserving API requests. | Development and production route classifiers remain separate lists that must stay aligned. |

## Additional repairs

### Data integrity and concurrency

- Production Setup now accepts typed field commands instead of stale full-record replacement. SQLite uses an immediate transaction. PostgreSQL uses a missing-or-stored compare-and-set statement, reapplies a command after contention, stops after eight attempts, and returns HTTP 409 when it cannot converge. This deliberately replaces the former `PUT` route with `PATCH`. API clients that called `PUT` must migrate.
- Working Plan edits are serialized. Each quantity click resolves against the latest queued Working Plan, so rapid controls no longer send absolute values derived from the same stale render.
- Working Plan queues, cached workspaces, busy state, conflicts, and errors are owned by Build identity. A delayed edit from one Build cannot become active or visible after the user switches Builds, and separate Builds do not block each other's edit queues.
- Manifest selections preserve scalar and multi-value choices. An absent Plan selection inherits the repository default, a nonempty value overrides it, and an empty list explicitly selects none for a known multi-select group. Unknown empty tombstones are inert. Writes and preflight reject selections above a group's maximum. Selections below its minimum remain incomplete. Repository manifest defaults continue to reject empty lists. Autosave state is isolated by Build ID.
- Plan recomputation and the manifest option editor share one default-resolution rule. The manifest builder returns those resolved selections, so the editor shows the choices that planning already applied without writing untouched defaults or undeclared one-variant choices back to storage.
- Source creation retries reuse the Source already created. Source content, editor drafts, selection, and asynchronous responses are keyed by Source identity.
- Profile watcher reload, reconciliation, sync, and shutdown are serialized. Filesystem events and WebSocket broadcasts retain tenant ownership.

### Security and external boundaries

- API-key authentication enters tenant context before lookup. Multi-user profile sync is disabled for the shared host filesystem, host slicer mutation is administrator-only, and public profile data omits host paths and resolved configuration.
- GitHub and Discord linking requires stable provider identity and verified email ownership. OAuth response bodies and HTTP calls are bounded by 15-second deadlines. A linked GitHub identity skips optional email discovery. A new identity links by email only when GitHub returns a verified address. Password-reset mail uses only the configured public origin.
- Source filesystem policy distinguishes trusted single-user self-hosting from isolated multi-user and SaaS deployments. Isolated deployments reject caller-supplied `local_path`, canonicalize content beneath the Source-owned repository root, reject root and nested symbolic-link escapes, and resolve a revision only for the Source that owns it. Public Source DTOs redact host paths and expose `content_available` instead.
- Buffered remote HTTP reads share one streaming byte-budget implementation that cancels discarded or oversized responses. GitHub, covers, guides, slicer calls, printer proxies, and assistant providers use caller-specific budgets.
- GitHub API requests compose caller cancellation with a two-minute deadline that remains active through the bounded response-body read, so stalled headers or bodies cannot permanently block Source monitoring.
- Assistant provider calls have a five-minute total deadline. MCP cancellation propagates through the tool loop, guide work, provider fetches, and web search. Web search composes caller cancellation with a 30-second HTTP header-and-body deadline across Brave, Exa, and DuckDuckGo. Its DNS preflight remains outside that deadline.
- The slicer sidecar validates JSON configuration at the HTTP boundary, requires usable G-code and successful process exit, reports accurate health, and does not disclose operational exception text.
- Legacy sidecar ZIP handling validates central and local headers, rejects encrypted, multidisk, ZIP64, and unsupported entries, and measures selected expanded output and compression ratio while streaming.

### Filesystem, storage, and printer behavior

- Source scanning skips symbolic-link escapes and cycles.
- Local uploads and GitHub sync retain the canonical repository manifest inside the immutable Source revision, so the manifest read during planning belongs to the same content generation as its printable files. Saving Source YAML through the API derives and activates another immutable revision. Startup and live-restore migration archive the former mutable workspace override after publication.
- The first multi-user account owns the bootstrap `default` tenant directly. This replaces the historical partial table-by-table claim and keeps new claims under one identity. A versioned database repair resolves an unambiguous ownership mismatch on the active Source revision without changing its revision key or snapshot location. It fails closed when a protected conflicting revision needs manual recovery and does not generally recover or re-tenant inactive Source history.
- `activateSourceRevision` requires a nonempty Source version, so publishers cannot drop the update-check identity while switching the immutable revision used by accepted-Plan freshness.
- Source snapshot downloads close response streams that declare invalid or over-budget lengths before rejecting them.
- SQLite self-host full-backup metadata is versioned and covers the 11 durable roots in [`FULL_BACKUP_ROOTS`](../../web/apps/server/src/services/backup-scope.ts), including `path-hints.yaml`.
- Path hints are option-group inference rules. Their document and rule fields are validated, and unsupported or no-op deployment rules fail closed instead of being ignored.
- Bambu and printer transfer artifacts have bounded lifetimes and failure cleanup.
- PrusaLink object inspection reads only a 64 KiB prefix even when firmware ignores `Range` and declares the full file length.
- Source deletion returns a discriminated conflict when immutable history prevents removal.

### Product behavior and maintenance

- Synced README documents are distinct from the synthetic live-README fallback and load from the document endpoint.
- Source selection, Source editor ownership, GitHub ref lookup, Production Setup mutation, manifest autosave, and printer status queries reject stale asynchronous results.
- Build selection is reconciled from the URL before fallback selection can publish local intent. A valid query remains authoritative through the cold profile load. Legacy studio redirects preserve the requested Build, while genuine local choices remain shareable through the `profile` query parameter.
- The dead slicer-folder adapter, its contract variant, and an unreferenced Build Sources panel were removed.
- Comment cleanup removed reviewer provenance, duplicated narration, and obsolete suppressions while retaining tested protocol and safety rationale.
- The production dependency graph resolves `qs` 6.16.0. Dependency audit evidence appears in the Verification section.

## Verification

Final verification ran on 2026-09-04 UTC after a fresh `npm ci` install.

| Gate | Command | Result |
| --- | --- | --- |
| Clean dependency install | `cd web && npm ci` | Installed 723 packages. Audited 728 packages with 0 vulnerabilities. |
| Project quality | `cd web && npm run quality` | ESLint, both TypeScript checks, all four production package builds, workflow smoke, and both browser scripts passed. The Vite production build transformed 2,454 modules. |
| Release and build tooling | Included in `npm run quality` | Release tests passed 32/32. Atomic package-publication tests passed 7/7. The public-release audit found 1,471 files, all 14 required documents, and all 12 screenshots. |
| Contracts | Included in `npm run quality` | 63/63 tests passed across 7 files. |
| Domain | Included in `npm run quality` | 142/142 tests passed across 19 files. |
| Web application | Included in `npm run quality` | 1,241/1,241 tests passed across 244 files. |
| Server | Included in `npm run quality` | 2,024/2,024 tests passed across 260 files. |
| Workflow smoke | Included in `npm run quality` | 12/12 local tests passed: 7 workflow-smoke cases with generated file and ZIP fixtures, and 5 release-workflow checks. |
| Browser checks | Included in `npm run quality` | The skip-link and dark Checkoff-sheet browser scripts both passed. |
| Manifest validator | `python3 -m unittest -v manifests.tests.test_validate` | 15/15 tests passed, including canonical-to-embedded copy drift checks. |
| Slicer sidecar | `cd slicer-sidecar && env UV_CACHE_DIR=/tmp/pp-uv-cache uv run --with flask==3.1.3 python -m unittest -v test_sidecar.py` | 8/8 tests passed. |
| Production dependency audit | `cd web && npm audit --omit=dev` | 0 vulnerabilities. |
| Repository hygiene | `cd web && npm run audit:cleanup` | Checked 1,471 files, 58 Markdown files, and 1,294 source files. Found 0 broken local Markdown targets. The four zero-inbound files are intentional command entry points. The seven exact-duplicate groups are packaged legal, manifest, icon, or test-configuration copies. |
| Public artifact audit | `cd web && npm run audit:public` | Passed with 1,471 files, 14 required documents, and 12 screenshots. |
| Patch hygiene | `git diff --check` | Passed with no whitespace errors. |

The isolated runtime exercise started the development-mode server against a copied SQLite data directory and configured it to serve the production web build. Startup protected the schema-31 database with a pre-update backup, upgraded it to schema 33, and reported a connected, supported SQLite deployment from `GET /health`. Playwright then followed the legacy `/plans/2/studio` route to `/sources?profile=2`, opened Source variants, verified the selected Badge option, toggled Handle, waited for persistence, reloaded, and confirmed the new value. It opened the intended Build from Builds, followed its Checkoff link to `/progress?profile=2`, and verified the visible `1 / 2 verified` state. The page emitted no browser errors, and the captured Checkoff screen was inspected before the isolated server drained cleanly.

An independent final diff review found no remaining P0 or P1 defect in the current Source migration and ownership repair. It also identified the wider historical v3.3 tenant-claim cohort described below, which this audit does not misclassify as repaired.

### Follow-up verification on 2026-09-05

The follow-up uses the production server builds, not the development server. The baseline is commit `ebda63acef67c64b2cde875923702d365999b936`, built in a separate temporary worktree with its own dependency install. No developer or production data directory was used.

The baseline application created a Source and Build on schema 31. After shutdown, the test retained a complete copy of that data directory. The rehabilitation build then opened the test directory, reached schema 33, and retained the Build and a file under `sources`. The generated database-only protective backup matched every table's pre-upgrade rows. Both database versions passed SQLite integrity and foreign-key checks.

The test next created a full backup through `POST /backups`, created another Build, and changed the test file. `POST /backups/restore` removed the later Build and restored the file. API reads continued to work against schema 33. Finally, the baseline production binary started against a copy of the preserved pre-upgrade directory. It served the original Build on schema 31 and retained the original file. Each application process shut down cleanly.

This proves upgrade, live full-backup restore, and offline rollback for an isolated single-user SQLite fixture. It does not prove historical multi-user recovery, PostgreSQL rollback, concurrent-writer safety, or rollback without losing post-upgrade writes. The protective startup archive contains only the database. A matching stopped full-directory copy is still needed when rollback must also restore files.

The temporary automation and logs are under `/tmp/pp-upgrade-proof-rHPJ7A`; these are local evidence, not release artifacts. The proposed historical recovery command, conflict policy, and acceptance tests are tracked in [issue #31](https://github.com/poitee/PrintPartner/issues/31). That command is not implemented by this change.

`cd web && npm run test:release` now passes 36 tests, including four Docker startup guards. `bash -n scripts/docker-startup-smoke.sh` passes. The new container smoke test creates its own root-owned named volume, checks the running process and database owner, and verifies graceful shutdown and persistence across a restart. Web CI runs this test against the production image. Local execution is blocked by Docker socket permissions and password-required sudo; container results must come from CI.

The first PR CI pass exposed a PostgreSQL packaging defect. Its initial SQL migration still used a path relative to the former flat `dist` directory. A built-artifact test reproduced the missing file. The migration now lives under `src/data/postgres` and is copied and required in every atomic server release. The test passes through the production adapter's migration loader and stops at the database query boundary. It runs as `npm run test:runtime` after the production build in `npm run quality`. The rebuilt artifact, focused lint, and 61 schema and database-bridge tests passed locally. The live PostgreSQL smoke test remains the integration proof.

## Known limits

- Artifact deduplication and a complete revision, export, and backup retention policy remain open.
- Restore is rollback-capable but not globally quiesced or crash-journaled.
- The built-in backup, restore, and storage estimate cover the supported SQLite self-host data directory. They do not back up PostgreSQL or S3 storage. Those deployments require database-native and object-store backups.
- General multi-statement PostgreSQL repository callbacks remain process-local. The database-native compare-and-set repair is intentionally limited to Production Setup. PostgreSQL SQL was adapter-tested because this environment did not provide a live PostgreSQL server.
- `path-hints.yaml` configures option-group inference for one deployment, not one tenant. Host profile sync is unavailable in multi-user mode by design.
- The outbound hostname check is not proof against DNS rebinding.
- A compressed sidecar response and its selected decompressed output can each occupy up to the 512 MiB policy, and chunk concatenation can briefly add another copy. ZIP extraction remains synchronous.
- HTTP rate limits use an in-memory store and therefore apply per server process rather than across a horizontally scaled deployment.
- No physical Klipper, Prusa, Bambu, webcam, or slicer binary was available. Hardware protocols are covered by deterministic adapter and route tests, not live devices.
- Source watcher coordination and restore serialization are process-local. Watcher shutdown does not await active work.
- Self-host upgrades require one application version at a time against the SQLite database and data directory. A concurrently changed legacy Source manifest is retained as a recoverable migration backup, but mixed-version writers are not serialized into the new Source revision.
- A v3.3.0 installation that enabled `MULTI_USER` only after creating data may already contain a partial tenant claim. This release prevents new partial claims. Its versioned repair handles only an unambiguous ownership mismatch on the active Source revision. A protected conflicting revision stops startup for manual recovery. The repair does not generally recover or re-tenant inactive Source revisions. It also does not reconcile Source documents and notes, Plan drafts and revisions or their dependent history, accepted Plates, slicer and printer configuration, print jobs, telemetry, or events. Keep a pre-upgrade backup. Every installation that ran the v3.3 claim path needs an ownership review, and any split or conflicting graph needs graph-aware tenant recovery.
- The Docker image must start its entrypoint with enough privilege to repair a fresh data-volume owner before dropping to the application user. Static guards and a fresh-volume CI smoke test now cover this sequence. Recursive ownership repair can delay startup on a large data volume.
