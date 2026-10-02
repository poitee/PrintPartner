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

The stage copies the real production dependencies and checks their native SQLite addon with the staged Node. Native architecture must match the builder. On macOS, the stage uses `/usr/bin/lipo` to select the verified Node architecture from universal addons before moving them into Frameworks or measuring dependencies. Already-thin target addons keep their exact bytes. Missing or invalid target slices stop staging; selected candidates replace staged files only after validation. This normalization precedes nested signing and measurement. The manifest covers build content, Node, complete dependency files, and exact symlink targets. Rust checks dependencies again before each compatibility process start. Generated inventories stay outside source control. The inventory records missing resolver roots inside the package so adding a nearer node_modules directory is rejected. Node ancestor resolution outside the package remains a measured blocker; the global search flag alone does not confine it.

Release builds reject `--dev-stage`, `--data`, and the timed native probe argument. Packaged resource lookup has no global Node fallback. A package needs the actual staged resources and a Rust binary compiled with that stage's `PP_DESKTOP_RELEASE_MANIFEST`.

The unsigned bundle helper expects pinned `cargo-tauri` 2.12.1 installed on macOS:

```sh
PP_DESKTOP_STAGE=/absolute/stage/path bash rust/scripts/desktop-bundle.sh
```

It validates the completed measured stage, invokes Tauri with `--no-sign --no-binary-patching`, and refuses other hosts. The generated macOS configuration leaves runtime resources to `assemble-macos-resources.py`; Tauri still copies the measured Node and Frameworks files and creates the icon, plist and main executable.

The assembly helper requires a fresh unsigned app with matching product identity and native bytes. It copies the complete runtime tree with relative aliases intact, checks the private candidate against the unchanged manifest, and atomically publishes it to the absent `Contents/Resources/desktop-runtime` destination. Missing or altered source files, escaping aliases, unrelated resources, an existing runtime destination and failed copies stop assembly.

This helper has not established a signed release. macOS nested code must be signed before generating its final inventory and compiling Rust. Bundling must preserve those bytes. Sign the outer app afterward, compare nested hashes again, and verify notarization, stapling, installation, and native launch separately. A Linux native process receipt proves neither macOS behavior nor successful UI rendering.

## Check unsigned macOS bundles in CI

The `Native macOS bundle` workflow builds separate arm64 and x86_64 apps on `macos-26` and `macos-26-intel`. Each job installs Rust 1.99.0, Node 24.21.0 ABI 137, and Tauri CLI 2.12.1. It installs the locked npm tree on that architecture, builds the desktop React assets, stages production dependencies, and calls the existing unsigned bundle helper once. Native npm builds inherit `MACOSX_DEPLOYMENT_TARGET=13.5`. Cargo fetch uses the committed lockfile; the app build runs offline and fails if either lockfile changes.

To inspect a completed app on macOS, keep the exact manifest used to compile it, then run:

```sh
python3 rust/scripts/check-macos-bundle.py \
  --app '/path/Print Partner.app' \
  --manifest /path/bundle-manifest.json \
  --arch arm64 \
  --receipt /path/bundle-verifier.json
```

Use `--arch x86_64` for the Intel app. The checker requires the installed `Info.plist` floor to equal 13.5. It compares installed Node, frontend, backend, metadata, complete dependency files, resolver roots, and relative workspace aliases with the frozen inventory. It inspects every app-owned Mach-O with `file`, `lipo`, and `otool`. Every binary must match the job architecture and target macOS 13.5 or earlier. External native dependencies fail verification unless they are system libraries under `/usr/lib` or `/System/Library`. Receipts list those system libraries; the app does not bundle them. Dependency traversal keeps the loading executable and image chain separate for each process. Node addons use `printpartner-node` and the rpaths of their own loader chain. They cannot borrow the Tauri executable's rpaths. Dylibs inherit rpaths from their actual chain, and `@loader_path` resolves relative to the image that declares it. Receipts retain those executable contexts and resolved dependencies.

The workflow copies the app to a separate path with a space in its directory name and repeats all checks against that installed tree. Each verifier runs the installed Node, checks a real SQLite query, and paints and encodes a Canvas image through the locked `@napi-rs/canvas` addon. It checks the pixel values, PNG signature, and canonical loaded addon paths against both installed aliases. This probe uses the measured resolution preload and confined arguments. It does not establish that the current shipping process passes those arguments; that enforcement has a separate review gate.

Each architecture uploads an unsigned app archive when one exists, the exact compile-time manifest, the stage manifest after bundling, generated bundle configuration, tool versions, build logs, and original and relocated verifier receipts. Available evidence uploads even when a check fails. Parser and inventory negative controls also run on Linux with `python3 rust/scripts/check-macos-bundle.py --self-test`. Linux checks cannot establish Mach-O, Info.plist, or bundle behavior.

These jobs cover unsigned assembly and installed resource checks. Native launch and rendered React verification remain separate gates. The existing timed lifecycle probe needs a debug build and Linux-specific isolation, so these release jobs do not run it. Signing still follows the required sequence: finish nested signing, measure nested bytes, compile Rust with that manifest, assemble without signing or binary patching, then sign the outer app and compare the nested hashes again. This workflow supplies no signing credentials and creates no release, notarization submission, or deployment. Node remains temporary compatibility code.

The `Desktop runtime` workflow runs on Ubuntu 24.04 for Rust and desktop dependency changes. It generates a current-head manifest after the real desktop asset build, builds `pp-server`, runs the eight real `runtime_m0` tests, backend units and Clippy, boundary and format checks, authenticated workflow and cleanup proofs, and gateway effects, product, and streaming probes. Crate selection excludes `pp-desktop` from Linux compilation. The test fixtures require `/usr/bin/node`, so the disposable runner points that path at the pinned setup-node runtime before measurement. Logs and exact manifest bytes upload on failure. This workflow needs the gateway test files from the reviewed integration stack; the Native-only base does not contain them.
