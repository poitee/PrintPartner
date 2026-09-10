# Workflow cleanup, September 2026

This cleanup covers logging controls, printer activity reads and writes, and
current workflow guidance. It does not certify third-party printers or production
installations that were not connected during verification.

## Changes

- Workflow Tracking now stops new workflow events at every severity. Existing
  events remain available. General server diagnostics continue. Configuration
  changes are validated before they take effect, and Settings displays the
  server's saved value. These settings reset when the server restarts.
- Watching queries now respect both the requested Build and printer host.
  Host reconciliation still considers all Builds using that host.
- Checkoff reads its Build queue once per refresh and groups the result by state.
  Previously it made four requests. Responses from an earlier Build or refresh
  cannot overwrite the current queue.
- Production now uses one queue request instead of five. All Production uses one
  instead of four. The legacy `applied` alias no longer causes a duplicate read.
- Identical printing snapshots do not rewrite stored links. New progress and
  lifecycle transitions still persist. A regression checks 72 unchanged polls.
- Printer polling requests an unattributed-print refresh only when its returned
  list changes, including when a previously visible print disappears.
- Help and Library notices describe autosave instead of a manual Plan publishing
  step. The operations guide uses the correct GET log-export endpoint.
- The disconnected manual-publishing components and their private helpers and
  tests were removed. Domain-generated next-action labels now describe saving.
  The internal Accepted Plan revision model remains unchanged.

The previous hook issued four requests per refresh. Its regression test now
requires exactly one, or 75% fewer queue requests. This is not a page-load or latency benchmark. Each
request loads the JSON-backed queue; consolidation removes redundant loads.
Legacy awaiting-result repair can perform additional work during a read.
The combined response also includes dismissed history, which Checkoff does not
display. Measure response size before treating this as a latency improvement.

## Verification

Run these commands from `web/`:

```sh
npm run test -w @print-partner/server -- src/routes/logging.test.ts src/routes/printer-checkoff-progress.test.ts src/routes/workflow-guide.test.ts
npm run test -w @print-partner/web -- src/lib/checkoffConsoleActivity.test.tsx src/lib/helpPageModel.test.ts src/components/sources/SourceUpdateNotice.test.ts src/components/checkoff/PrinterLiveStrip.test.tsx src/components/settings/LoggingManagementCard.test.tsx
npm run test -w @print-partner/web -- src/components/export/useProductionCheckoffLinks.test.tsx src/pages/GlobalProductionPage.test.tsx
npm run typecheck
```

The watching regression starts a temporary local HTTP server. It checks that a
Build-and-host request returns only its link, while global and host-only requests
still return links from multiple Builds. No printer hardware is contacted.

For the browser journey, follow the isolated-app setup in
[the verification skill](../.agents/skills/verify-printpartner/SKILL.md), using a
fresh data directory whose name starts with `/tmp/pp-cleanup-`. Point Vite at the
isolated API with `VITE_DEV_API_TARGET`. From `web/apps/web/`, run:

```sh
CLEANUP_UI=http://127.0.0.1:5185 CLEANUP_API=http://127.0.0.1:18878 \
  node test/browser/workflow-cleanup.browser.mjs
```

The script refuses a server outside that temporary data prefix. It changes the
logging toggle, reloads Settings, checks capture pause and resume, and checks Help
for autosave guidance. It restores the initial tracking setting. Do not run other
configuration-changing tests against the same instance at the same time.

The completed run passed the full `npm test` command with 3,754 tests, the
production build, workflow smoke tests, packaged-server runtime tests, and the
standard browser suite. The new queue browser journey passed separately.
The raw `npm run quality` command stopped on lint errors in an existing untracked
local `_pm_smoke.mjs`. Repository lint was run with that file excluded; the file
was not changed or added to the cleanup commit.

## Queue measurement

The `measures consolidated queue reads` regression compares twenty refreshes of
a synthetic 2,000-link queue through the real route and SQLite-backed repository.
It asserts 80 setting reads for the former four-request flow and 20 for the
combined flow. It prints a `QUEUE_REFRESH_BENCHMARK` JSON record.

One local run produced these results:

| Measurement | Four requests | Combined request |
| --- | ---: | ---: |
| Queue reads over 20 refreshes | 80 | 20 |
| Median refresh | 58.1 ms | 20.8 ms |
| 95th-percentile refresh | 141.5 ms | 46.6 ms |
| Response bytes per refresh | 587,824 | 587,791 |
| Highest sampled process heap | 200.1 MB | 249.1 MB |

The timing run shared the machine with other tests. The heap samples come from
the same process without forcing garbage collection between cases. They do not
measure retained memory or prove a memory improvement. The deterministic result
is fewer requests and queue parses, with no material payload-size change for this
fixture. Source scanning, model rendering, and real printer latency are outside
this queue measurement.

The browser check also opens All Production, Production, and Checkoff and verifies
that each requests a combined queue with the expected Build scope. Unit tests
check the number of requests because React development mode can repeat effects.

Reference sharing remains export and validation only. Manifest import and direct
Git publishing are not implemented. See [reference sharing](reference-sharing.md).

## September 10 release verification

A clean worktree at `992c3fa` passed the unmodified `npm run quality` gate:
lint, type checks, 3,755 unit tests, workflow-smoke tests, production build,
packaged-server tests, and all four standard browser scripts. The earlier
untracked scratch-file lint failure does not occur in this clean checkout.

Separate browser checks passed for logging capture pause/resume, JSON and JSONL
log downloads, and combined queue requests on All Production, Production, and
Checkoff. The local-source API workflow passed through Checkoff, STL export,
and production static assets. All writes used disposable data directories.

Nodemailer was updated to 9.1.1. `npm audit --audit-level=high` passed; moderate
advisories remain for adm-zip and Hono, including Hono's dependants. A JSON
transport check rendered a password-reset email without sending mail.
Generated dependency notices were refreshed after the upgrade.

All three Compose configurations validated. Local Docker runtime verification
was unavailable because this environment cannot access the Docker socket.
The PR's container checks remain a merge prerequisite. Physical printers,
external accounts, Postgres, S3, and the user's production server were not tested.

PR review added three regressions: Checkoff must not request fleet links without
a selected Build; Git packaging must reject pretty-printed manifests over 4 MiB
even when the compact request is smaller; publisher schemes and hosts are
case-insensitive. All three failed before the fixes. The fixes passed 121 focused
tests, changed-file lint, and both application type checks. Browser rechecks
passed sharing, logging, Build-scoped queues, and an empty Checkoff page with no
fleet-queue request. The updated commit requires a fresh CI run before merge.
