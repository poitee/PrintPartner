# PR #189: live app evidence at 2e34ab46

Implementation HEAD and remote PR head were both `2e34ab468400ea7719b1e73d92a2a8ec19b03f05` before the run and before publishing. PR: https://github.com/poitee/PrintPartner/pull/189 . Exemption: none. All four captures succeeded on 2026-10-10 UTC, using this VM's T3 collaborative desktop browser. Screenshots contain only the actual app viewport.

## Exact reproduction

1. Check `git rev-parse HEAD` and `gh pr view 189 --repo poitee/PrintPartner --json headRefOid`: both must match the implementation SHA above. Use that worktree for the API and client. The evidence commit adds only this directory; application source is unchanged.
2. Use Node 22.23.3 / npm 11.19.0. Run `npm --prefix web ci`, then `npm --prefix web run build`. npm blocked native install scripts on this VM, so run Node 22 against `../prebuild-install/bin.js` from `web/node_modules/better-sqlite3` to install its native binary. Build passed, exit 0.
3. Create isolated storage: `mktemp -d /tmp/pp-pr189-XXXXXX > /tmp/pr189-data-path`. In the implementation worktree, run:

   ```bash
   PRINT_PARTNER_DATA_DIR="$(cat /tmp/pr189-data-path)" HOST=127.0.0.1 PORT=18765 GRE510_REPO="$PWD" node --conditions=development --import ./web/node_modules/tsx/dist/loader.mjs evidence/pr189-2e34ab46/api-restart.mjs
   ```

   The evidence harness starts the real API and seeds two disposable GitHub sources. It adds 25 seconds before actual outbound GitHub fetches, making the real update-check job long enough to observe. No job events, socket closes, HTTP responses, or UI are mocked. Seeds are idempotent so the same harness can restart against the same isolated database.
4. Run `npm --prefix web run dev -w @print-partner/web -- --host 0.0.0.0`. Use T3 `preview_status`, `preview_open` at `http://127.0.0.1:5173/library`, then `preview_wait_for` for **Check now**. Wait for the API health request to succeed. The client and API both run from this worktree.
5. Evaluate the included `browser-recorder.js` in the browser main frame with `preview_evaluate`. It observes native WebSocket/fetch events and emits `PR189-EVIDENCE` console messages. It does not change requests or responses. Click the real **Check now** button. Save `preview_snapshot({includeImage:false,save:true})` as `job-running.png`.
6. While that job runs, send `kill -USR2 "$(cat /tmp/gre510-api.pid)"`. The harness calls real Fastify `app.close()`, waits 3.5 seconds after close finishes, rebuilds the API with the existing ports/worker/database, and listens again. Shutdown also drains pending requests, so actual unavailability lasts longer than 3.5 seconds. Save `job-retrying.png` during the outage.
7. Wait for **Update check finished** with `preview_wait_for`, then immediately save `job-complete.png`. Read `window.gre510Evidence` and `document.body.innerText` using `preview_evaluate`; these are saved in `reconnect-trace.json`. The completed row expires after about 2.5 seconds, so capture promptly.
8. Observe that no more job traffic occurs after completion. At 21:28:58.713Z, 15 seconds after the last socket close, trace length was still 90 and the completed row had retired.
9. For the missing-job run, clear the recorder in place (`window.gre510Evidence.length=0`), click the real **Check now** again, and kill only the owned API process with `kill -KILL "$(cat /tmp/gre510-api.pid)"` while the new job is running. Immediately rerun the API command from step 3 against the same isolated data directory. This is a full process restart with a new in-memory job runner. The browser continues observing its original job ID, now unknown to the replacement server.
10. Wait for **Job not found** and immediately save `job-not-found.png`; save the native trace and UI text as `missing-job-trace.json`. Timing of polling vs socket reconnect can vary: this recorded run received socket 1008 before the next HTTP poll. At 21:31:18.636Z, 23 seconds after 1008, trace length was still 20 with no further job socket/poll and no active row.
11. Run the focused tests at the implementation head: `npm --prefix web run test -w @print-partner/web -- src/api/jobWebSocket.test.ts src/context/JobContext.test.tsx`. Result: 2 files / 39 tests passed, exit 0. Stop only owned processes and remove the exact disposable storage directory.

## Observed reconnect and completion

Same job throughout: `2056221b-25d0-495f-ba61-4d7b68c6466c`.

```text
21:27:53.411Z socket open; 21:27:53.447Z running / Running… / 10
21:27:54.104Z socket close 1005, empty reason
21:27:54.536Z reconnect construction (432 ms after close); close 1006
21:27:55.375Z reconnect construction (824 ms after close); close 1006
21:27:57.205Z reconnect construction (1,822 ms after close); close 1006
21:28:01.125Z reconnect construction (3,914 ms after close); close 1006
21:28:09.145Z reconnect construction (8,014 ms after close); close 1006
21:28:19.152Z reconnect construction (10,001 ms after close)
21:28:19.161Z socket open; same job running / Running… / 10
21:28:43.384Z same socket/job done / Complete / 100
21:28:43.761Z socket close 1005 after terminal state; no reconnect
```

Intervals use the recorder's monotonic `ms` field, so browser timer scheduling is included. HTTP 502 timestamps also show poll backoff: 21:27:54.272, 54.682, 55.493, 57.101, 21:28:00.311, 06.720; intervals approximately 409, 811, 1,609, 3,209, 6,409 ms. Successful polls reset the interval to about 400 ms.

## Observed 1008 terminal path

Lost job: `00d7430b-7bf2-453e-9e51-22ca8f02a34d`.

```text
21:30:46.610Z socket open; 21:30:46.652Z running / Running… / 10
21:30:46.882Z process killed: socket close 1006
21:30:47–53Z real failed reconnects (1006) and HTTP 502 polls
21:30:53.325Z replacement API process listening
21:30:55.375Z reconnect construction for the original lost job ID
21:30:55.399Z socket open
21:30:55.402Z close 1008, reason "Job not found"
UI: CHECK SOURCE UPDATES / Job not found / Error; red Job not found toast
```

## Scope and artifacts

Same-job completion proves a real API listener restart while its real worker survives. It does not assert survival of a Node process restart: the unchanged server stores jobs in memory. The second run explicitly demonstrates job loss after process restart and the correct terminal UI.

The actual native browser trace is retained as JSON; `browser-console.log` contains the matching recorder console messages, with no headers, cookies or credentials. `server-lifecycle.log` is a minimal sanitized excerpt. `idle-observations.json` records the post-terminal checks. Screenshots were visually checked for app-only content; no desktop chrome, terminal, tokens, or personal information is present.

- [Running app](job-running.png)
- [App during reconnect backoff](job-retrying.png)
- [Same job Complete](job-complete.png)
- [1008 Job not found UI](job-not-found.png)
- [Reconnect trace and terminal UI text](reconnect-trace.json)
- [1008 trace and terminal UI text](missing-job-trace.json)
- [Browser console log](browser-console.log)
- [Server lifecycle excerpt](server-lifecycle.log)
- [Idle observations](idle-observations.json)

P2 response: https://github.com/poitee/PrintPartner/pull/189#discussion_r4239263133 . The real attempt-count/deadline gap is tracked in [GRE-531](https://linear.app/greetz/issue/GRE-531/preserve-elapsed-time-observation-deadlines-during-transient-job-poll). No application code was changed.
