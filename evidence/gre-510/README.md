# GRE-510: real API shutdown, backoff reconnect, completion

Implementation head: `68838e92d2cfcba910428007533fb58bae57dd5b`.
PR: https://github.com/poitee/PrintPartner/pull/189
Exemption: none

Intended journey: Source Library → Check now → graceful API shutdown mid-job → jittered exponential reconnect → same job completes. Final-head capture is incomplete; see result below.

## Exact steps

1. In the implementation worktree at the head above, run `npm --prefix web ci` and `npm --prefix web run predev`.
2. Copy this directory's `api-restart.mjs` to `/tmp/gre510-api.mjs`. Create disposable storage with `mktemp -d /tmp/pp-gre510-XXXXXX`, recording it in `/tmp/gre510-data-path`.
3. From the repository root, run:

   ```bash
   PRINT_PARTNER_DATA_DIR="$(cat /tmp/gre510-data-path)" HOST=127.0.0.1 PORT=18765 GRE510_REPO="$PWD" node --conditions=development --import ./web/node_modules/tsx/dist/loader.mjs /tmp/gre510-api.mjs
   ```

   The harness starts the real `startServer(loadConfig())`, seeds one disposable source through the real repository, and adds 35 seconds of outbound latency before actual public GitHub API fetches. It does not replace any response, job, socket event, or HTTP poll.
4. Run `npm --prefix web run dev -w @print-partner/web -- --host 0.0.0.0`. Confirm `curl -fsS http://127.0.0.1:18765/health` succeeds.
5. Use T3 `preview_status`, `preview_open`, and `preview_navigate` to open environment port 5173 at `/library`. Evaluate `browser-recorder.js` (trim leading/trailing whitespace). It records native socket and HTTP events without changing requests, responses, or rendered UI.
6. Start T3 `preview_recording_start`. Click the real **Check now** button with `preview_click`. Save `job-running.png` using `preview_snapshot({includeImage:false,save:true})`.
7. While the job is running, send `kill -USR2 "$(cat /tmp/gre510-api.pid)"`. The harness calls the actual Fastify `app.close()`, which closes the job socket without a code; waits 3.5 seconds; rebuilds the full API with `buildApp(config, ports)`; and listens on the same port.
8. Save `job-reconnected.png`. Wait for **Update check finished** using `preview_wait_for({text:"Update check finished",timeoutMs:45000})`. Save `job-complete.png`, stop the T3 recording, and save `window.gre510Evidence` plus the terminal UI text to `network-trace.json`.
9. After completion, leave the page idle for more than 10 seconds and verify that there are no further job sockets or polls. Stop only the owned API/Vite processes and remove the exact disposable directory after checking its resolved path.

## Result and blocker at the final head

- The real socket opened at **18:29:57.879Z** and delivered a running snapshot.
- Actual graceful API shutdown closed it at **18:29:58.885Z**, code **1005**, empty reason.
- Native socket constructions followed at **18:29:59.370Z**, **18:30:00.417Z**, **18:30:02.425Z**, **18:30:06.668Z**, **18:30:15.704Z**, **18:30:26.041Z**, and **18:30:36.085Z**. Their failed handshakes closed with 1006. Backoff increased to its 10-second cap; browser timer scheduling adds overhead to measured intervals.
- HTTP 502 observations were at **18:29:59.132Z**, **18:29:59.548Z**, **18:30:00.360Z**, **18:30:01.970Z**, **18:30:05.177Z**, showing the added polling failure backoff. Observation remained running.
- This run's API close also drained an already-pending update-check HTTP request; therefore shutdown lasted longer than the harness's 3.5-second explicit pause. The real API logged a fresh listen at **18:30:36.126Z**.
- Before terminal UI could be captured, T3 returned `PreviewAutomationNoAvailableHostError`: no connected automation host, explicitly **Do not retry**. `preview_recording_stop` failed for the same reason, so there is no retrievable final-head recording or verified terminal UI capture.
- **job-running.png** and **job-retrying.png** are actual app-only T3 screenshots at the final head. No terminal, browser chrome, machine hostname, token, or personal data is included.
- Step 8 (terminal capture/recording transfer) and step 9 (browser observation after terminal) were not completed in this run. The README preserves the intended reproduction instructions so a connected T3 browser can finish the proof.

## Earlier-head completion proof

The complete shutdown/reconnect/success journey was recorded at parent head `b0c20e77d964db3ba9db5fb7df870d68007006a8`: https://github.com/poitee/PrintPartner/tree/evidence/gre-510-b0c20e7/evidence/gre-510 . That recording and native trace prove completion only at that earlier head. The final commit changes HTTP failure backoff, and its focused regression passes, but this does not replace requested final-head browser proof.

## Restart scope

The evidence harness invokes real Fastify API shutdown and rebuild while retaining the in-process job runner/database. It is not a Node process restart. The unchanged production job runner stores jobs in memory; process exit loses them. No server persistence/resumption claim is made.

## Validation at the final head

- Focused socket/JobContext tests: **2 files, 39 tests passed**.
- Full client suite: **272 files, 1,455 tests passed**.
- `npm --prefix web run lint` and `npm --prefix web run typecheck`: **exit 0**.
- Final-head end-to-end proof: **BLOCKED by disconnected T3 preview host**.

Artifacts: [running UI](job-running.png), [retrying UI](job-retrying.png), [API harness](api-restart.mjs), [native recorder](browser-recorder.js).
