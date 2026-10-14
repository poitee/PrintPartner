# Grok Build score, PR 369 round 1

Scored SHA: `1d4e93e63313eb99d1bcbacf99cf773f720ba441`
Score: 9/10
Result: pass
Blocking findings: none

This score covers the unsigned Linux IPC-denial slice only. It does not clear merge. GitHub merge state is MERGEABLE / UNSTABLE, and three required checks were still pending when this report was written.

## What was scored

PR https://github.com/poitee/PrintPartner/pull/369 against main. Three-dot diff from `d96e74673c93011fa1c0e2b9dfdbd60e6e282159` is only `rust/tests/webkit_stl_smoke.py` (+71/−1). Worktree HEAD matches the PR head and the tree is clean. No GRE-380 or GRE-456 paths are in the diff.

The new `verify_native_permissions` runs after authenticated `/builds` and before HTTP navigation, remote CSP, and STL rendering. It calls `window.__TAURI_INTERNALS__.invoke` and requires:

- `plugin:app|exit`, `plugin:window|close`, `plugin:window|destroy`, and `plugin:webview|create_webview_window` to reject with `*.not allowed. Permissions associated with this command:` plus `core:app:allow-exit`, `core:window:allow-close`, `core:window:allow-destroy`, and `core:webview:allow-create-webview-window`
- those four messages to exclude `not found`
- `plugin:fs|read_file` and `plugin:shell|execute` to reject with the exact string `fs.read_file not allowed. Plugin not found` and `shell.execute not allowed. Plugin not found`
- `window.__TAURI__ === undefined`, window label `main`, webview label `main`
- the same document, `#root`, href, and random token after the six invokes
- a screenshot written to `native-permissions-denied.png`

Pinned Tauri 2.12.1 matches that shape. `resolve_access_message` in `tauri-2.12.1/src/ipc/authority.rs` emits `Permissions associated with this command` for a known command absent from the capability, and `Plugin not found` when the plugin key is absent. The webview IPC handler rejects that message before the plugin handler when ACL resolution is empty (`src/webview/mod.rs`, debug_assertions branch). Empty `permissions` on capability `main-no-native-commands` for window `main` is already in `rust/crates/pp-desktop/tauri.conf.json`, with `withGlobalTauri: false`. `WebviewWindowBuilder` uses label `main`. Metadata labels are injected from those runtime labels. `pp-desktop` does not depend on `tauri-plugin-fs` or `tauri-plugin-shell`.

The snapshot binary contains `main-no-native-commands`, `Permissions associated with this command`, `Plugin not found`, and the four `allow-*` identifiers. It does not contain the release string `not allowed by ACL`, `tauri-plugin-fs`, `tauri-plugin-shell`, or `wdio`. SHA-256 `f96150775a662a7232695790c58d547dbf4aa35c19b1aa081cf4564a56428fd9`.

Stage commit is the scored SHA in both `head-stage/release.json` and `head-stage/bundle-manifest.json`. Manifest SHA-256 `91758fe4ea8f26feffa8c1b9991f0c226c62159f6f0876f998ee76c8c6f0f1cd`. Both hashes were unchanged after the verifier run. Script SHA-256 `32cc56af47ae4d44bb65c1c1ab21a45491a37981fb98ac424417ef0a95306270`.

## Independent run

Command, from the repository root, through `land.py slot` (author run had already released the slot):

`env LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 dbus-run-session -- xvfb-run -a -s '-screen 0 1280x1024x24' python3 rust/tests/webkit_stl_smoke.py --binary .../pp-desktop --stage .../head-stage --output .../grok-native-r1`

Exit 0 in 55.26s. Log: `/persist/home/.local/state/pstack-t3/gre353-permissions/grok-native-r1.log` (`EXIT:0`). No `failure.json`.

`grok-native-r1/receipt.json`: `result` PASS, `proof_class` `native_linux_webkitgtk_webgl`, `commit` the scored SHA. Permission receipt matches the six messages above. Parent origin `http://127.0.0.1:42685`, global API absent, both labels `main`, all four preservation flags true. Navigation PASS with the HTTP control loaded, blob script not executed, document preserved. Remote frames PASS: native and strict observations record an enforced `frame-src` violation, zero child document gets, and no child message. STL mesh bytes matched, WebGL 2.0, `gl_error` 0, 1839 visible pixels, 1721 center pixels, 6 colors, 320×240.

`native-permissions-denied.png` (44177 bytes, PNG) is the PrintPartner builds shell. `desktop-viewer.png` shows the production dialog for `webkit-known-mesh.stl` with the red mesh. Driver stderr is the baseline AT-SPI accessibility-bus warning and the libayatana-appindicator deprecation warning, then a shutdown receipt with the five cleanup flags true and `errors` empty.

## CI at score time

Not settled. Do not treat this PR as green.

Pending: Rust partition (1/2), Rust partition (2/2), runtime.

Passed: cargo deny check, Lint Evidence block, changes, parity (22), parity (24), rust-verify, server-smoke, source-artifacts, webkit-stl.

Skipping: both macOS bundle jobs, linux-precheck, macos-storage-gate.

## Limitations

The associated-permission sentence is the debug_assertions IPC message. This dev binary is the binary that can load `--dev-stage`, and the release denial text is compiled out of it. Mac, signed, release, validated handoffs, and explicit tenant mapping stay open.

The four ACL checks use substring membership of the permission id. On Tauri 2.12.1 the live messages are exactly one identifier each, and no other autogenerated id contains those strings. The denial screenshot is saved and was inspected here; the test asserts document identity in the page and does not hash the PNG.

The author's first exact-head journey timed out at the existing STL canvas wait after the permission receipt had already passed (`head-native-attempt1`). The author's retry and this single independent run both passed that wait. No source was rebuilt or edited for this score.
