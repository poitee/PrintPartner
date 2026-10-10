# GRE-510 local app evidence

Implementation: `6e8be0bb3ff71fd15e33c1242523705d35129c6f`.
Model/harness: Codex gpt-6.1-sol (medium), T3 VM 135.

## Exact steps

1. Run `npm --prefix web ci` and `npm --prefix web run predev`.
2. Create disposable storage using `mktemp -d /tmp/pp-gre510-XXXXXX` (this run: `/tmp/pp-gre510-GKvBp6`). Start the unmodified server with `PRINT_PARTNER_DATA_DIR=<that directory> HOST=127.0.0.1 PORT=18765 npm --prefix web run dev -w @print-partner/server`.
3. Start the actual client using `npm --prefix web run dev -w @print-partner/web -- --host 0.0.0.0`. Confirm `/health` on `127.0.0.1:18765` returns `ok: true`.
4. Create a disposable GitHub source via `POST /sources`, JSON `{"name":"GRE-510 evidence source","source_kind":"github","repo_url":"https://github.com/poitee/PrintPartner"}`. This only enables the Check now control; no repository sync runs.
5. Open `http://localhost:5173/library` in the T3 collaborative browser. Evaluate `browser-recorder.js` once in this fresh page. It records real native WebSocket construction/open/close events. It substitutes only the start response for `/jobs/check-source-updates` with the unknown job ID `gre510-missing-evidence` and holds the HTTP poll until aborted. The real WebSocket server and client close handler are used; no synthetic close event or rendered text is injected.
6. Click the real **Check now** button. Capture `job-not-found.png` immediately and inspect `window.gre510Evidence`.
7. Leave the page untouched for more than 60 seconds. Inspect the recorder again; `network-trace.json` includes both observations.

## Observed results

- The real connection opened at `13:04:27.055Z` and closed at `13:04:27.065Z` with code **1008**, reason **Job not found**.
- The actual JobTray and error toast displayed **Job not found**, captured in the screenshot.
- The held HTTP poll was aborted at `13:04:27.065Z` by the client terminal handler.
- At `13:05:42.937Z`, more than 75 seconds after the close, the count remained **one WebSocket connection and one aborted poll**. No reconnect or polling loop.
- All app requests used this VM's local client/API. Hosts .80 and .81 were never used.
- The start-response substitution and held HTTP poll are controlled reproduction inputs, explicitly recorded above. This proves the client missing-job boundary; it makes no server implementation claim.

## Validation

- Failing tests first: missing-job retry test failed; non-transient close and jitter tests failed before the retry fix.
- Focused client suite: 24 tests passed across the socket and JobContext tests.
- Complete client suite: 272 files, 1,440 tests passed including the going-away close case in the aggregate web run.
- `npm --prefix web run lint`: passed.
- `npm --prefix web run typecheck`: passed (both server and client, server unchanged).
- Changed-file ESLint and client typecheck rerun after the final test-only adjustment: passed.
- PR diff is limited to four files in `web/apps/web`. `git diff origin/main -- web/apps/server` is empty. Local `main` is stale at `292783d`, while the requested origin/main base is `0ccdecd`; no old server files were restored from that stale ref.

- Final aggregate `npm --prefix web test`: exit 0. Client: 1,440 tests; main server run: 2,197 tests; separate accepted-STL bundle suite: passed. Contracts, domain, desktop parity, schema, release and build-tool checks also passed.
- Owned API and Vite processes stopped, and the exact disposable directory `/tmp/pp-gre510-GKvBp6` was removed after verification.
