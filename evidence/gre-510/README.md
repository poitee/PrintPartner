# GRE-510: real API shutdown, backoff reconnect, completion

Implementation head: `b0c20e77d964db3ba9db5fb7df870d68007006a8`.
PR: https://github.com/poitee/PrintPartner/pull/189
Exemption: none

Journey: Source Library → Check now → graceful API shutdown mid-job → jittered exponential reconnect → same job completes.

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

## Observed result

- Initial real socket opened at **18:24:57.344Z** and delivered the running snapshot.
- Graceful shutdown closed it at **18:24:58.000Z** with browser code **1005** and empty reason.
- Reconnect delays, measured from close to next construction: **431 ms**, **1,129 ms**, **1,709 ms**, **3,587 ms**. These fit the 500/1,000/2,000/4,000 ms exponential schedule with ±20% jitter; the last interval includes timer scheduling overhead. The 10-second cap is covered by unit tests.
- Three attempts during downtime closed with **1006**. HTTP polls returned **502**; they did not terminate observation or cancel socket reconnects.
- The fifth socket opened at **18:25:05.102Z** and delivered a running snapshot for the **same job ID**.
- At **18:25:32.598Z**, that socket delivered **done / Complete / 100**. The actual job strip showed **Complete / Done**, and the toast said **Update check finished**.
- The subsequent socket close was **1005**, with no retries because the job had already reached its final state.
- Screenshots and the 38-second T3 recording contain only app UI. No terminals, browser chrome, tokens, machine hostnames, or personal data are included. The trace stores paths rather than hostnames.

## Scope of restart

This is a real Fastify API shutdown and rebuild, retaining the real job runner and database in the evidence harness. It is **not a Node process restart**: the production `InProcessJobRunner` stores jobs in memory, so killing its process loses the job. A client-only change cannot make the same job survive a process restart. No server source was changed, and no persistence/resumption behavior is claimed. Retaining the worker lets this evidence prove transport shutdown, backoff reconnect and successful completion independently of that existing server limitation.

The previous missing-job reproduction remains at https://github.com/poitee/PrintPartner/tree/evidence/gre-510-6e8be0b/evidence/gre-510 . Current-head focused tests cover both socket-first missing-job handling and HTTP-404-first handling, with one terminal callback, clear `Job not found`, and observer cancellation.

## Validation at this head

- Focused socket/JobContext suite: **2 files, 38 tests passed**.
- Full client suite: **272 files, 1,454 tests passed**.
- `npm --prefix web run lint`: exit 0.
- `npm --prefix web run typecheck`: exit 0, contracts/domain builds and both server/client typechecks.
- Normal push to `bot/gre-509-511`; author `poitee <915726+poitee@users.noreply.github.com>`.

Artifacts: [running](job-running.png), [reconnected](job-reconnected.png), [complete](job-complete.png), [T3 recording](api-restart.mp4), [native trace](network-trace.json), [API harness](api-restart.mjs), [browser recorder](browser-recorder.js).
