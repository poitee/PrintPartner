# GRE-353 implementation report

The verifier now checks native remote-frame CSP enforcement after navigation acceptance and before existing seed/STL acceptance. The only source change is `rust/tests/webkit_stl_smoke.py`. The diff has 299 added lines and one changed receipt line. No children, commits, pushes, PRs, Linear changes, builds, Rust changes, UI changes, workflow changes or package changes were made.

One completed observation feeds the pure `frame_denial` predicate. The predicate checks attempt and parent preservation, then execution, then a trusted enforcing full-policy event, then unexpected document GETs. The live negative first proves document GET, execution beacon and authenticated postMessage, then requires exact `target_executed` equality. Model the Domain determined that separation. Prove It Works determined the real extended native runs. Unslop shaped this report and the source prose. Parent-supplied how, design comparison, judge, synthesis and checkpoint artifacts supplied grounding and design ownership. I did not repeat their delegation because the brief prohibits children.

The two retained HTTP listeners serve inert strict/relaxed parents and script-bearing children on distinct origins. The relaxed policy changes only frame-src. Every target has Python and credentials-omit browser preflight. Post-insertion request accounting excludes both preflight GETs. Request evidence contains route labels and monotonic times. The listener never records request headers, cookies, environment or bootstrap URLs. The observer retains original Document/root identity, document token and exact href including the navigation query, plus connected ordinary iframe state. It samples for at least three seconds after the first event and saves partial JSON and phase screenshots before acceptance assertions. Missing event fields fail collection.

The MiniBrowser has a separate driver process group, separate XDG directories, explicit --automation, no native stage arguments, and no TAURI_WEBVIEW_AUTOMATION. Both binaries resolve the same WebKit shared library and SHA256. Controls use MiniBrowser 2.52.6. Native capabilities identify Wry 0.57. Linked engine evidence is the comparison, not browser-name equality.

Commands run included the following.

```sh
python3 /persist/home/.local/state/pstack-t3/gre353-frames/implement.py
python3 -m py_compile rust/tests/webkit_stl_smoke.py
git diff --check
git diff --stat
git diff --numstat
git status --short
python3 /persist/home/pstack-t3/skills/landing/scripts/land.py slot -- env LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 dbus-run-session -- xvfb-run -a -s '-screen 0 1280x1024x24' python3 rust/tests/webkit_stl_smoke.py --binary /persist/home/.local/state/pstack-t3/gre353-next/target/debug/pp-desktop --stage /persist/home/.local/state/pstack-t3/gre353-frames/base-stage --output /persist/home/.local/state/pstack-t3/gre353-frames/implementation-run
python3 /persist/home/pstack-t3/skills/landing/scripts/land.py slot -- env LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 dbus-run-session -- xvfb-run -a -s '-screen 0 1280x1024x24' python3 rust/tests/webkit_stl_smoke.py --binary /persist/home/.local/state/pstack-t3/gre353-next/target/debug/pp-desktop --stage /persist/home/.local/state/pstack-t3/gre353-frames/base-stage --output /persist/home/.local/state/pstack-t3/gre353-frames/implementation-final
```

Read-only inspection also used cat for required skill/design/prototype/source files, rg for AGENTS.md discovery and process inspection, ls for stage/artifact checks, ps for owned process status, and a Python JSON summary of the measured receipt. No applicable root/tests AGENTS.md was found. The rust/scripts/AGENTS.md does not govern this file. The temporary implementation script and skill-read copy remain in private state.

The first extended run exited zero and produced `implementation-run/receipt.json`, `frames.json`, four frame screenshots, control/native driver logs, navigation evidence, viewer screenshots and pixel evidence. Positive and negative controls each observed one document GET and one script beacon with an authenticated message. Strict and native each observed a trusted frame-src enforcing event with the full gateway policy and the exact parent URI. Both had zero post-insertion child GETs, zero beacons and no authenticated messages. Durations were 3.015 seconds strict and 3.062 seconds native. The unchanged STL checks measured 1,839 visible pixels, 1,721 center pixels, six colors, matched mesh bytes and GL error zero.

Owned control driver cleanup reaped the driver. Both fixture threads stopped and sockets closed. Cleanup errors were empty. Probe listeners and nodes are removed in finally. The existing main function still owns native teardown. Neither the frame receipt nor this report certifies final native teardown from the pre-teardown PASS receipt.

The final extended run also exited zero after adding explicit event-field completeness checks and target/token evidence. Its artifacts are in `implementation-final/`. All four phases passed again. Final measured phase results and cleanup follow.

```json
{
  "result": "PASS",
  "observations": {
    "positive": {
      "denial_result": "target_executed",
      "duration_seconds": 3.035695450998901,
      "message": true,
      "beacon_count": 1,
      "document_get_count": 1
    },
    "strict": {
      "denial_result": null,
      "duration_seconds": 3.0366312620026292,
      "message": false,
      "beacon_count": 0,
      "document_get_count": 0
    },
    "negative": {
      "denial_result": "target_executed",
      "duration_seconds": 3.027419217003626,
      "message": true,
      "beacon_count": 1,
      "document_get_count": 1
    },
    "native": {
      "denial_result": null,
      "duration_seconds": 3.061253857005795,
      "message": false,
      "beacon_count": 0,
      "document_get_count": 0
    }
  },
  "cleanup": {
    "control_driver_reaped": true,
    "fixture_threads_stopped": true,
    "errors": []
  }
}
```

No syntax, diff-check or verifier failures occurred in either run. GTK emitted the distro accessibility-service warning in the control log. That warning did not affect the run. No baseline rebuild was necessary.

The evidence covers the supplied unsigned Linux baseline binary and this working-tree verifier. Parent still owns independent verification, review, committed exact-head rebuild, CI and the Grok gate. MiniBrowser controls isolate frame-src enforcement. They do not prove that Wry would admit the cross-origin frame without CSP. The claim is bounded by the measured observation interval and does not cover macOS or signed releases.
