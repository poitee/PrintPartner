# GRE-353 frame design judge

Scorer: Grok Build. Later implementation author: Codex. Design comparison only. No repository edits, commits, pushes, children, or PR score. Branch `owner/gre353-frames-202610140900-4acb` at `03158903f134fc1f42b8f4b17cc40d47daa89d28`. `rust/tests/webkit_stl_smoke.py` is 351 lines. The desktop WebKit workflow stays unchanged.

## Recommendation

Use the MiniBrowser candidate as the base. Implement it only in `rust/tests/webkit_stl_smoke.py`. Graft the predicate and receipt corrections below. Leave temporary native-policy builds out of this slice.

A passing native proof is a live-run result. Source order makes the trusted event expected. If that event is absent, the verifier fails closed.

## Rubric

| Criterion | MiniBrowser | Native-policy builds |
| --- | --- | --- |
| Trusted enforcing event | Required on the native document and the strict control | Required, including a patched blocking build |
| Executable positive iframe | Same-engine HTTP iframe; prototype already ran one | Runs only after two private `pp-desktop` builds |
| Relaxed observation rejected by the same predicate | Present; membership check is too weak | Exact reason `target_executed` |
| About 300 additions, no production UI or workflows | Holds in one Python file | Private Rust copies and two Cargo builds miss the smallest shape |
| Owned cleanup and secret-free receipts | Separate control process group; native cleanup stays put | Sound, and it relocates the existing session owner |

## Why this base

`minibrowser-prototype/observations.json` is MiniBrowser 2.52.6. The allow parent (`frame-src *`) ran the iframe script and recorded no violations. The deny parent (`frame-src 'none'`) left `executed` false and recorded one trusted event: `frame-src`, `enforce`, `originalPolicy` `frame-src 'none'`, `blockedURI` `http://127.0.0.1:46459`. That is the engine channel. It is not the acceptance predicate.

WebKitGTK 2.52.6 `PolicyChecker::checkNavigationPolicy` calls `allowChildFrameFromSource` and returns `IgnoreLoad` before `dispatchDecidePolicyForNavigationAction` (`PolicyChecker.cpp` near 180-188 and 337). `allowChildFrameFromSource` reports the violation (`ContentSecurityPolicy.cpp:644`). Wry 0.57.0 applies `on_navigation` only inside that client callback (`webkitgtk/mod.rs:553-575`), with no main-frame test. A `frame-src` denial does not depend on `AllowedOrigin::admits` (`pp-desktop/src/lib.rs:76`, installed at `main.rs:150`). Missing frame contents or zero HTTP hits still cannot name the blocker. An absent trusted event cannot be relabeled as CSP enforcement.

The policy to match is the asset header at `pp-gateway/src/assets.rs:214`: `frame-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`. `.github/workflows/desktop-webkit.yml` already installs `libwebkit2gtk-4.1-dev` and `webkit2gtk-driver` and runs this verifier under dbus and Xvfb. MiniBrowser is in that runtime library. No workflow edit and no production edit.

## Native builds stay a comparison

That candidate answers whether the iframe would execute after `frame-src` was removed and Wry admitted the fixture origin. `how.md` places that counterfactual outside this slice. It copies the workspace, patches temporary `main.rs` and `assets.rs`, and builds `pp-desktop` twice. The copies are uncommitted, and they still carry production policy into the verifier. Nothing measured shows that those builds fit the existing job. The shared observer does not need them once MiniBrowser can execute and deny.

## Grafts

Call `verify_remote_frames` after `verify_navigation` and before `SEED`. Keep the navigation-control query in the current URL. One helper owns both fixture listeners and the control session. One probe and one predicate serve every phase.

The predicate consumes a completed observation and returns one reason. Collection errors, WebDriver errors, and dead fixtures raise first. On the live relaxed observation, `require_execution` passes, then the same predicate returns exactly `target_executed`. Equality is the negative control. A timeout or any other exception is a setup failure.

Predicate order: intact cross-origin attempt and preserved parent, then authenticated execution, then the trusted event, then an unexpected frame GET. Execution is decisive, so a relaxed run fails as `target_executed`. An unexpected frame GET is its own reason and never replaces the event.

The event requires `isTrusted`, `effectiveDirective == 'frame-src'`, `disposition == 'enforce'`, a blocked origin equal to that phase's child origin, and `documentURI` equal to that phase's parent URL aside from a fragment. `originalPolicy` matches the full gateway string after whitespace and one trailing semicolon are normalized. Directive names, order, and source expressions stay. The prototype's short policies are not stand-ins.

The positive parent is the gateway policy with only `frame-src` replaced by the child origin. Require a child document GET after insertion, a script-only beacon, and `postMessage` checked by token, exact origin, and `event.source === iframe.contentWindow`. No sandbox, `srcdoc`, lazy loading, or `targetOrigin '*'`.

Keep the current native driver cleanup in `main`. The control driver is another process group, with its own XDG directories, `--automation`, and without product stage arguments or `TAURI_WEBVIEW_AUTOMATION`. Fixture sockets stay bound through shutdown, `server_close`, and a bounded join. Cleanup errors fail the frame result. The existing PASS receipt still does not certify native teardown.

Compare the resolved `libwebkit2gtk-4.1.so.0` of the supplied `pp-desktop` and MiniBrowser. A mismatch, a missing binary, or a missing event field is a named failure. There is no skip.

Receipt field `remote_frames` carries origins, both policies, raw allowlisted event fields, control execution, the `target_executed` rejection, duration, and route-labeled request deltas. Omit bootstrap URLs, cookies, raw headers, and the environment.

## Still unproven

This judge did not launch the native binary. The 2.52.6 order makes the native event expected; the verifier still has to record it. Absence is `native_csp_enforcement_unproven`.

The prototype slept one second, posted to `*`, omitted `documentURI`, and never ran the allow observation through the denial predicate. Two WebDriver sessions at once are untested. A control that does not start is a failed prerequisite. The proof class remains unsigned Linux WebKitGTK.

## Next step

Stay near 260-295 additions. Past about 300, remove wrappers. Do not add the Cargo-copy path, another module, or a production navigation change.
