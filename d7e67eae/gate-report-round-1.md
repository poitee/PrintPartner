# Gate report, round 1

Verdict: **PASS**. Score: **10 / 10**. Head: `d7e67eaed9bc186ceeba3e54dfd3f61490912a40`.

PR: https://github.com/poitee/PrintPartner/pull/361. Reviewer: Grok Build. Author: Codex gpt-6.1-sol. No blocking findings.

## Score

| Item | Points | Result |
| --- | --- | --- |
| Acceptance, screenshot weight included because there is no UI change | 5 | 5 |
| Tests and CI settled green | 2 | 2 |
| No new errors in logs | 2 | 2 |
| Diff scope | 1 | 1 |
| **Total** | **10** | **10** |

Visual judgment is null. Deterministic gate is pass: `tests_green` true, `still_running` empty, `failing` empty, `new_errors` empty, `out_of_scope` empty, same head (`deterministic-gate.json`).

## Head

Local `HEAD`, `origin/owner/gre353-frames-202610140900-4acb`, and `refs/pull/361/head` were `d7e67eaed9bc186ceeba3e54dfd3f61490912a40` before review, after the verifier, and at scoring. Worktree was clean. Source hash of `rust/tests/webkit_stl_smoke.py` remained `61b6b0c453e245d82f702298667234d398afbc491612fe520dccddd7557b013f`, the hash in `fixed-head-proof.json`.

Merge-base `75c254271924f7eca94c2f38893f656720662e19`. Diff is 3 files, 305 insertions, 4 deletions:

- `rust/tests/webkit_stl_smoke.py`
- `rust/crates/pp-api/Cargo.toml` (`rustls` `=0.23.45` to `=0.23.46`, features unchanged)
- `rust/Cargo.lock` (one `rustls` package, checksum `48e13bd8c0e9365c43cfa5c9e8f9ad49d3c8444926c9aac819e0e4dc503c8fdf`)

That checksum matches crates.io for `rustls` 0.23.46, and the version is not yanked. No `0.23.45` remains under `rust/`. No deny.toml or workflow edit.

## Checks

`checks-gate.json` on this head: `mergeStateStatus` CLEAN, base `main`, 20 completed rollup entries, 19 SUCCESS, 1 SKIPPED (`bundle (macos-26-intel, ...)`). None pending or failing.

Parent API library run in `fixed-api-tests.log`: 14 passed, including `smtp_rustls_encrypts_data_and_rejects_untrusted_certificate`, compiling `rustls v0.23.46`. `cargo-deny-summary.json`: cargo-deny 0.20.2, advisories, bans, licenses, and sources ok, policy unchanged.

## Acceptance

`verify_remote_frames` runs after `verify_navigation` and before the STL seed (`webkit_stl_smoke.py` around lines 571–576). Outer native cleanup stays in `main` (lines 621–648). The PASS receipt has no teardown field.

`FRAME_POLICY` at line 216 is the asset header in `pp-gateway/src/assets.rs` line 217. SPA `GET /builds` is served as `index.html` through that header (`pp-gateway/src/lib.rs` lines 460–469 and 605–623). Relaxed policy replaces only `frame-src 'none'` with the child origin (line 435). This run's policies were:

- strict: `frame-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`
- relaxed: `frame-src http://127.0.0.1:40871; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`

Two stdlib loopback `ThreadingHTTPServer`s stayed up for every phase. Control parent origin `http://127.0.0.1:43659` and child origin `http://127.0.0.1:40871` differed. Native parent origin `http://127.0.0.1:45017` also differed from the child. `ldd` plus sha256 required the same `libwebkit2gtk-4.1.so.0.21.10` (`32ca85d8…7574b`) for `pp-desktop` and MiniBrowser. Capabilities stayed `wry` 0.57 versus MiniBrowser 2.52.6. The MiniBrowser session does not claim Wry would admit the iframe if CSP were removed. `AllowedOrigin::admits` (`pp-desktop/src/lib.rs` lines 109–114), installed at `main.rs` line 147, still admits only the app origin; the recorded blocker is the trusted `frame-src` event.

`frame_denial` (lines 238–250) returns `target_executed` on a completed authenticated message or beacon, and returns null only when the attempt stayed intact, the parent document, `#root`, token, and href stayed put, a trusted enforcing `frame-src` event matches the child origin, the parent URI, and the full gateway policy (`frame_csp_enforced`, lines 219–235), and no post-baseline child document GET remains. Setup exceptions propagate. The live negative is asserted equal to `target_executed` after `require_execution` (lines 466–471).

Predicate audit re-executed against the current source: 24 mutations rejected, live negative reason `target_executed`. The same function on this head's prior `fixed-native/frames.json` accepted strict and native and rejected positive, negative, and a message-forged native observation.

Collector behavior that the predicate result depends on:

- Preflight Python GET and browser `fetch` with `credentials:'omit'` complete before the request baseline (lines 336–352). Allowed deltas therefore count only the post-insertion document GET and script beacon.
- The iframe is connected, unsandboxed, not `srcdoc`, and not lazy (lines 379–380).
- `postMessage` must match the token, child origin, and `event.source === iframe.contentWindow` (lines 366–368). The child posts to the parent origin, not `*`.
- Preservation of three seconds starts when the matching enforcing event is first observed and is asserted before denial can pass (lines 395–404).
- Event fields are the fixed allowlist. A missing or extra field raises `unsupported_csp_event_observation`.
- Request rows store a route label and monotonic time. Cleanup failures append to `errors` and fail the frame result before `result` is set to PASS (lines 476–505).

## Independent verifier

Command, under `land.py slot`, exit 0 in about 52 seconds. Log: `gate-native-round-1.log` (`GATE_EXIT:0`, no traceback). Output: `gate-native-round-1/`. Supplied binary and `fixed-stage` were not rebuilt. Stage manifest commit is this head. No `failure.json`. No leftover `pp-desktop`, MiniBrowser, or WebKitWebDriver.

| Phase | Denial | Message | Document GET | Beacon | Enforcing event | Seconds after event |
| --- | --- | --- | --- | --- | --- | --- |
| positive | `target_executed` | true | 1 | 1 | none | |
| strict | null | false | 0 | 0 | trusted `frame-src` enforce, policy and `documentURI` match | 3.053 |
| negative | `target_executed` | true | 1 | 1 | none | |
| native | null | false | 0 | 0 | trusted `frame-src` enforce, blocked URI `http://127.0.0.1:40871`, `documentURI` equals the navigation-control href | 3.001 |

Native `parent_href` equals `navigation.json` `http_control_url` (`…/builds?navigation_control=81b2652bbac4589f9ad3b877ab1e7de6`). Four distinct attempt tokens. Cleanup: `control_driver_reaped` true, `fixture_threads_stopped` true, `errors` empty. Navigation result PASS, blob script did not run, HTTP control loaded. STL receipt: mesh matched, `gl_error` 0, WebGL 2.0, WebKit WebGL, 1839 visible pixels. Receipt `commit` is this head and `remote_frames` equals `frames.json`.

`desktop-driver.log` records the app's own shutdown object (`errors` empty) plus the existing AT-SPI and ayatana warnings. That shutdown object is not in `receipt.json`. The control log has the same AT-SPI warning. These are not new test failures.

## Blocking findings

None.

## Non-blocking findings

None.
