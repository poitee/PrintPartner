# Full site audit — 2026-08-31

## Verdict

The revised product workflow is coherent on the happy path. Source Library owns reusable projects, Sources configures a Build, Plan publishes a revision, Production prepares new work, and Checkoff owns printer observation, missed-job recovery, external print files, and verification. The current risks are operational: storage grows without a lifecycle, restoring a large backup is not transaction-safe, several upload boundaries are effectively unlimited, and important failure states do not offer recovery.

Audit status: **issues found**. No critical issue was found. Five high-impact operational issues should be addressed before treating backup/restore and automatic source monitoring as production-safe.

## Coverage

- Exercised the 10 canonical authenticated routes at 1280×800 and 390×844: Builds, Source Library, Sources, Plan, Production, Checkoff, All Production, Printers, Settings, and Help.
- Exercised Login, Setup, Forgot Password, and Reset Password at desktop and mobile sizes against the deployed public surface.
- Checked eight legacy route patterns.
- Built an isolated local Source, attached it to a Build, generated and published a Plan, read Checkoff, changed unit progress, and exported an STL package.
- Interacted with the Production method decision, the no-printer plate-assignment recovery path, watched-printer past-print intake, external G-code/BGCode/3MF intake, and the backup restore picker.
- Reviewed the source, storage, backup, source-monitoring, printer-polling, and multi-user boundaries.
- Ran the full automated suite: 31 release checks and 3,070 package tests passed; lint, app/server typechecks, and both real-browser regression scripts passed.

The canonical sweep produced 20 route/viewport records. Every record had one `main`, one `h1`, no failed HTTP response, no console or page error, and no body-level horizontal overflow.

## What works well

- The primary workflow is explicit and consistent. Help states `Sources → Plan → (Production ↔ Checkoff)`, and the navigation, headings, next-action cards, and cross-links follow it.
- Source monitoring is prominent in Source Library. The UI distinguishes update detection, optional automatic sync, and the fact that a published Build does not change until a new Plan revision is accepted.
- Production asks one consequential question before presenting route-specific tasks. Plate preparation then puts Required units, printer assignment, and layout in the same workspace.
- Checkoff now owns the printer-facing intake users requested. Its dialog explains watched-printer storage, missed jobs, multiple prints, and external G-code, binary G-code, and 3MF files. With no configured printer, it offers both computer upload and a direct Settings link.
- The backup restore file picker is present and accepts `.tar.gz`; an upload is validated before confirmation.
- Empty states, responsive reflow, focus indicators, skip navigation, landmarks, and mobile workflow navigation were consistently usable.
- Archive traversal, nested ZIP, entry count, extracted-size, printer-path, and camera-origin checks are substantially guarded.

## Findings

### High

#### 1. Source history and backups have no storage lifecycle

Every Source revision is materialized as a complete immutable directory under `repos/<source>/revisions/<revision>`. The working copy remains under `sources`, and generated artifacts remain under `exports`. A backup includes `repos`, `sources`, `exports`, `thumbs`, and `covers` in full. There is manual backup deletion, but no age, count, quota, revision-retention, or export-retention policy.

The isolated workflow demonstrated the same STL stored three times: once in `sources`, once in an immutable revision, and once in an accepted export. This supports a likely cause of the reported 3.8 GB live backup. The audit could not inspect the authenticated live archive itself, so the live-file attribution remains an inference from the reproduced layout and current backup implementation.

Evidence: [backup directory selection](../../web/apps/server/src/services/backup-restore.ts#L38), [full-directory archive creation](../../web/apps/server/src/services/backup-restore.ts#L294), [immutable revision materialization](../../web/apps/server/src/services/local-source-snapshot.ts#L576), and [source history preventing deletion](../../web/apps/server/src/db/repository.ts#L3250).

Recommended change: introduce a content-addressed artifact store. Working trees, revisions, accepted exports, and backups should reference deduplicated blobs. Add explicit revision/export retention, per-category and total disk usage, a dry-run backup size breakdown, and configurable backup retention. Keep a manual “preserve forever” control for accepted releases that genuinely need it.

#### 2. Live restore is not transaction-safe and can require several times the archive size in free disk

The restore service says it should run only while stopped or in maintenance mode, but the HTTP route calls it while source and slicer watchers and job handlers remain live. Restore extracts the archive, copies all current data into `.pre-restore-backup`, deletes and recopies live directories, replaces SQLite, and reconnects. A mid-copy failure reconnects but does not roll the files and database back as one unit.

For a 3.8 GB compressed archive, peak disk demand may be much larger than 3.8 GB because the uploaded archive, extracted data, pre-restore copy, and replacement data can coexist. The UI does not preflight or explain this requirement.

Evidence: [maintenance-mode requirement](../../web/apps/server/src/services/backup-restore.ts#L378), [live copy and replacement sequence](../../web/apps/server/src/services/backup-restore.ts#L395), and [live route invocation](../../web/apps/server/src/routes/backups.ts#L249).

Recommended change: create one restore coordinator that enters maintenance mode, rejects new mutations, drains/stops jobs and watchers, validates free space, restores into a sibling staging root, health-checks the staged database and files, atomically swaps roots, and automatically rolls back on failure. Show required/free disk before confirmation.

#### 3. Upload boundaries permit memory or disk exhaustion

Fastify's global body limit is `Number.MAX_SAFE_INTEGER`, multipart `fileSize` is `Infinity`, and Source ZIP/file routes concatenate complete uploads in memory before validating their contents. Restore, Bambu Connect, and printer-send upload paths stream to disk but still inherit the effectively unlimited global policy. Checkoff's past-print upload is a positive exception with a 64 MiB route limit.

Evidence: [global upload limits](../../web/apps/server/src/app.ts#L110), [buffered Source uploads](../../web/apps/server/src/routes/sources.ts#L274), [unbounded printer-send parser](../../web/apps/server/src/services/printer-upload-multipart.ts#L64), and [bounded Checkoff upload](../../web/apps/server/src/routes/printer-checkoff.ts#L1084).

Recommended change: define limits by artifact kind, reject oversized requests before buffering, stream Source archives to bounded temporary files, enforce aggregate multipart limits, and return the allowed size in the UI and problem response.

#### 4. Automatic Source monitoring skips non-default tenants in multi-user mode

The long-lived watcher invokes tenant-scoped repository methods outside request context. The repository therefore falls back to the default tenant, while authenticated users use their user ID as tenant ID. Startup sync and scheduled update checks can silently omit every non-default tenant.

Evidence: [tenant fallback](../../web/apps/server/src/db/repository.ts#L793), [watcher Source enumeration](../../web/apps/server/src/services/source-watcher.ts#L27), [periodic check](../../web/apps/server/src/services/source-watcher.ts#L100), and [user tenant mapping](../../web/apps/server/src/services/auth-store.ts#L55).

Recommended change: make tenant enumeration explicit at the scheduler boundary and execute one isolated, observable run per tenant. Persist last-run/result per tenant and expose it in Source Library.

#### 5. Source polling accepts unsafe persisted intervals and has no overlap guard

The API accepts any numeric `interval_hours`. The isolated API accepted `0.000001` hours, then the audit restored it to 24 before the watcher's 60-second config poll observed it. A small positive persisted value creates a near-continuous timer, and the interval callback does not prevent a second check from starting while the first remains active.

Evidence: [unvalidated setting](../../web/apps/server/src/routes/settings.ts#L240) and [unguarded scheduler](../../web/apps/server/src/services/source-watcher.ts#L259).

Recommended change: accept a closed set or bounded range (`0` for disabled, otherwise a documented minimum), validate finite values at the API boundary, and serialize checks through a tenant-aware single-flight job.

### Medium

#### 6. Failed Plan and printer roster loads do not provide a recovery action

Plan shows load errors without Retry and can render no content when no prior review exists. Printers clears the last roster on failure, shows an alert, and then also renders “No printers,” which misstates a transient network failure. Neither state has a retry button.

Evidence: [Plan failure rendering](../../web/apps/web/src/pages/PartsPage.tsx#L210) and [printer roster failure](../../web/apps/web/src/pages/PrintersPage.tsx#L123).

Recommended change: use the same error-state card already used on Builds and All Production: keep stale data when available, distinguish “could not load” from “none exist,” and provide Retry.

#### 7. All Production can show stale remaining counts after a printer/checkoff event

Printer events refresh farm/checkoff links, but “Remaining by Build” comes from the separate profiles query and is not invalidated. A completed verification can therefore leave the count stale until another reload.

Evidence: [profiles-derived rows](../../web/apps/web/src/pages/GlobalProductionPage.tsx#L92) and [farm-only refresh callback](../../web/apps/web/src/pages/GlobalProductionPage.tsx#L199).

Recommended change: make the checkoff event invalidate both farm state and the affected Build summary, preferably through one typed domain event.

#### 8. Settings contains unnamed slicer controls

Existing slicer-row name inputs and their Enabled switches lack programmatic names. The visible “Enabled” text is adjacent but not associated. The audited default roster exposed three instances of each pattern. The filament hex field and Workflow Tracking switch use the same pattern. Placeholder-only add-slicer fields also lose their visible identity after entry.

Evidence: [slicer row controls](../../web/apps/web/src/components/settings/SlicerInstanceRow.tsx#L50), [add-slicer fields](../../web/apps/web/src/components/settings/SlicersSettingsCard.tsx#L256), [filament fields](../../web/apps/web/src/pages/SettingsPage.tsx#L436), and [workflow switch](../../web/apps/web/src/components/settings/LoggingManagementCard.tsx#L178).

Recommended change: give every field a persistent visible label and stable `id`/`htmlFor` or `aria-labelledby`; include the slicer name in each switch's accessible name.

#### 9. Builds has undersized status-link targets on mobile

The per-Build Checkoff and Production links measure about 16 px high because they are bare `text-xs` links without padding or minimum height. This is materially harder to tap than the otherwise good 44–46 px mobile workflow navigation.

Evidence: [Build status links](../../web/apps/web/src/pages/PlansPage.tsx#L425).

Recommended change: render these as compact 44 px link-buttons, or make the surrounding status cell the labelled target.

#### 10. Printer status polling can overlap on slow hosts

Printers and the Production send panel schedule a new fan-out every polling interval without an in-flight guard. Slow or offline hosts can accumulate concurrent requests.

Evidence: [Printers polling](../../web/apps/web/src/pages/PrintersPage.tsx#L173) and [Production polling](../../web/apps/web/src/components/export/PrinterSendPanel.tsx#L182).

Recommended change: use one shared printer-status query with cancellation/single-flight behavior, visibility awareness, bounded backoff, and event-driven refresh where supported.

#### 11. Bambu handoff artifacts have no successful-use retention policy

Successful Bambu handoff files remain under `exports/bambu-connect` indefinitely, and the global upload configuration provides no effective size ceiling. Ordinary printer upload jobs clean up in `finally`, but process termination can still leave their temporary directory behind.

Evidence: [Bambu artifact write](../../web/apps/server/src/routes/bambu-connect.ts#L36), [download without cleanup](../../web/apps/server/src/routes/bambu-connect.ts#L275), and [printer job cleanup](../../web/apps/server/src/services/printer-upload-job.ts#L15).

Recommended change: attach expiry and ownership metadata to handoffs, delete on acknowledgement or TTL, and sweep abandoned printer-upload directories on startup.

#### 12. Rebuilding a shared package can kill the development API

During this audit, `npm run typecheck` rebuilt the domain package by deleting `dist`. The running `tsx watch` API restarted on the unlink event before the new output existed, failed with `ERR_MODULE_NOT_FOUND`, and did not recover. The frontend remained available while every API request failed. This reproduces the operational shape of the earlier connection problem.

Evidence: [destructive domain build step](../../web/packages/domain/package.json#L18) and [server watch command](../../web/apps/server/package.json#L6).

Recommended change: build shared packages into a staging directory and atomically replace complete output, or run development imports from source with a coordinated workspace watcher. Add a smoke check that runs typecheck while dev remains healthy.

### Low

- Several page-specific loading messages are visible but not announced through `role="status"` or a live region. Sources, Plan, and All Production should use one consistent asynchronous-status component.
- Source selection, detail tab, and highlighted file are local React state rather than URL state, so refresh and shared links lose context.
- “Uncategorized” and “Uncategorised” appear in different Source Library surfaces.
- Direct navigation to `/plans/:id/studio` returns raw API JSON only in Vite development because the dev proxy bypass list handles exact SPA paths while production handles the dynamic path. The deployed live route returned HTML 200.

## Recommended implementation order

1. Build the artifact/storage lifecycle: usage inventory, deduplicated blobs, revision/export retention, backup scope and estimate, and automatic backup retention.
2. Put restore behind a maintenance-state coordinator with disk preflight, atomic activation, rollback, and an end-to-end restore test using a disposable data root.
3. Add upload limits and streaming at every external file boundary.
4. Make scheduled Source work tenant-explicit, validated, single-flight, and observable.
5. Fix user recovery states and cross-query invalidation in Plan, Printers, and All Production.
6. Close the Settings naming and mobile target-size accessibility gaps.
7. Consolidate printer polling and add TTL cleanup for printer handoffs.
8. Stabilize the workspace dev watcher and align dynamic SPA routing between Vite and production.

## Limits and evidence

- Protected pages on the deployed live box required credentials, so the authenticated product was not mutated or fully browsed. Public auth pages and public document routing were checked read-only.
- No physical Klipper, Prusa/Buddy, Bambu, or webcam endpoint was available in the isolated data set. Printer storage browsing, live cameras, and hardware-specific job transitions remain integration-test gaps.
- The 3.8 GB live backup was not downloaded. Its likely cause is supported by source review and by reproducing the same three storage copies in the isolated workflow.
- No destructive restore was run. Validation, confirmation UI, and implementation were reviewed; actual rollback behavior remains unproven because rollback is not implemented.
- Vite development timings include module transformation and were not used as production performance measurements.

Machine-readable route evidence and screenshots are under `/tmp/printpartner-full-site-audit-evidence-2026-08-31`, `/tmp/printpartner-full-site-audit-live-auth-2026-08-31`, and `/tmp/printpartner-full-site-audit-redirects-2026-08-31`. The append-only decision trail is `.audit/full-site-audit-2026-08-31.tsv`.
