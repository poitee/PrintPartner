# Run the native development app

Install Rust 1.99.0 and Node 24.21.0. Install the workspace dependencies with `npm --prefix web ci`. From the repository root, launch with:

```sh
PP_DEV_NODE=/absolute/path/to/node bash rust/scripts/desktop-dev.sh
```

The command builds the trusted React assets and real compatibility server, creates a new stage, embeds its measured inventory, and starts one native window with isolated temporary data. Set `PP_DEV_DATA` to an existing development directory to keep that directory across runs. Set `PP_DEV_STAGE` to a new directory to retain its staged files. The stage command refuses to overwrite an existing directory.

Closing the window hides it while core continues. The tray has Show, service status, a guarded Restart service action, and Quit. Quit and supported OS exits wait for the consuming core shutdown before the process returns. The webview receives no native commands. Navigation stays at the exact core origin and popups are denied. Existing external handoff flows need a separately validated native UX before they are accepted as working.

On the nonprivileged Linux development host, set `PP_NATIVE_SYSROOT` to the already extracted GTK/WebKit SDK. `native-sdk.sh` reads that SDK without changing it. Other hosts use their target-native development packages. This SDK does not produce a portable Linux distribution image.

## Create an unsigned target-native stage

Build the desktop assets first, then run:

```sh
python3 rust/scripts/stage-desktop.py --web web --node /absolute/path/to/node --output /new/stage/path --commit "$(git rev-parse HEAD)"
```

The stage copies the real production dependencies and checks their native SQLite addon with the staged Node. Native architecture must match the builder. The manifest covers build content, Node, complete dependency files, and exact symlink targets. Rust checks dependencies again before each compatibility process start. Generated inventories stay outside source control. The inventory records missing resolver roots inside the package so adding a nearer node_modules directory is rejected. Node ancestor resolution outside the package remains a measured blocker; the global search flag alone does not confine it.

Release builds reject `--dev-stage`, `--data`, and the timed native probe argument. Packaged resource lookup has no global Node fallback. A package needs the actual staged resources and a Rust binary compiled with that stage's `PP_DESKTOP_RELEASE_MANIFEST`.

The unsigned bundle helper expects pinned `cargo-tauri` 2.12.1 installed on macOS:

```sh
PP_DESKTOP_STAGE=/absolute/stage/path bash rust/scripts/desktop-bundle.sh
```

It invokes Tauri with `--no-sign --no-binary-patching` and refuses other hosts. This helper has not established a signed release. macOS nested code must be signed before generating its final inventory and compiling Rust. Bundling must preserve those bytes. Sign the outer app afterward, compare nested hashes again, and verify notarization, stapling, installation, and native launch separately. A Linux native process receipt proves neither macOS behavior nor successful UI rendering.
