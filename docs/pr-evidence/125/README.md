Source head: `11f1d0b2d2d4e9ca9acbd739c7bf3abc2e02a48c`

Actual Linux GTK/WebKit desktop, real Rust core, staged Node 24.21.0 compatibility runtime; isolated local display and disposable storage. No .80 or .81 host, mocked state, or browser substitute. The screenshots and receipts belong to this source head.

The upgrade proof seeded `Saved desktop Build` through the preceding verified 9fea133 server into an isolated home's `.print-partner`. It then mounted that home over the resolved real home using bwrap (without changing HOME or touching developer data), and started final-head pp-desktop **without --data**. The real window shows the saved Build (`native-legacy-build.png`). The database inode stayed unchanged, its row survived, no platform-specific core database appeared, and the native app exited 0 with complete cleanup (`legacy-home-receipt.json`, `legacy-native.stdout.log`).

The native missing-resource launch printed `desktop_startup_failed: resource_verification -> resources_unavailable -> os_error=2` before exiting 1. Its private path marker was absent from stderr (`startup-error.stderr.log`). Unit tests also cover owned storage, occupied persisted origin, missing/tampered releases, errno preservation and arbitrary-message redaction. The normal error dialog and timed debug branch share the unconditional logger. The normal-path capture (no timed flag) shows the actual dialog in native-startup-error.png, checks the same redacted cause and proves exit 1 after pressing OK. Linux uses a modal loop on Tauri's GTK thread to avoid blocking the dialog behind its main context.

`native-ready.png` and `tray-ready.png` show the real app and tray. `capture-native.py` suspends only its own Node child, waits for three real health misses, captures `Service stopping` during the ten-second reap window, then replaces its isolated socket with a directory to provoke the same cleanup failure as the Rust regression test. `tray-failed.png` captures the terminal Failed menu during shutdown; Restart is disabled. It removes the injected obstacle and terminates only its app. The fault exit 1 and `compat_cleanup_unproved` are expected, while the separate default-directory upgrade run proves the successful exit path. `native-events.json` records live DBus labels and source SHA.

Reproduce from the source head with Rust 1.99.0, Node 24.21.0, GTK3/WebKit 4.1 development libraries, Xvfb, openbox, tint2, xdotool, Python PyGObject, bwrap and dbus-run-session:

```sh
evidence_dir=$(mktemp -d /tmp/pp125-evidence.XXXXXX)
# Copy capture-native.py, verify-legacy-home.py, capture-startup-error.py and tint2rc from this archive
# into evidence_dir before running the captures.
node_bin=$(readlink -f /usr/bin/node)
npm --prefix web ci
VITE_PRINT_PARTNER_DESKTOP=1 npm --prefix web run build
python3 rust/scripts/stage-desktop.py --web web --node "$node_bin" \
  --output "$evidence_dir/runtime" --commit "$(git rev-parse HEAD)"
PP_DESKTOP_RELEASE_MANIFEST="$evidence_dir/runtime/bundle-manifest.json" \
  cargo build --manifest-path rust/Cargo.toml --locked -p pp-desktop -p pp-server
cp rust/target/debug/pp-server "$evidence_dir/pp-server-stage"
Xvfb :125 -screen 0 1440x1000x24 -nolisten tcp &
display_pid=$!
DISPLAY=:125 dbus-run-session -- python3 "$evidence_dir/verify-legacy-home.py" \
  --seed-binary "$evidence_dir/pp-server-stage" --seed-stage "$evidence_dir/runtime" \
  --seed-commit "$(git rev-parse HEAD)"
DISPLAY=:125 dbus-run-session -- python3 "$evidence_dir/capture-native.py" --repo "$PWD"
DISPLAY=:125 dbus-run-session -- python3 "$evidence_dir/capture-startup-error.py"
python3 rust/tests/enforced_launch.py --binary "$evidence_dir/pp-server-stage" \
  --stage "$evidence_dir/runtime" --output "$evidence_dir"
kill "$display_pid"
```

The reproduction above seeds the same legacy directory using the final runtime. To exactly repeat the recorded upgrade, first build/stage 9fea133 in a separate worktree and pass that binary, stage and SHA as the seed arguments. All seed writes go to the new evidence directory's isolated home.

Run web tests before generating the default manifest: they change dependency caches that the inventory measures. Keep manifest generation, Rust tests and subsequent web rebuilds sequential. Use the actual pinned Node executable, since the fleet PATH's Node is a shell wrapper while the runtime tests use /usr/bin/node.

```sh
npm --prefix web test
python3 rust/scripts/build-desktop-manifest.py --web web --node "$node_bin" \
  --output rust/bundle-manifest.json --commit "$(git rev-parse HEAD)"
cargo fmt --manifest-path rust/Cargo.toml --all --check
cargo clippy --manifest-path rust/Cargo.toml --workspace --all-targets --locked -- -D warnings
cargo nextest run --manifest-path rust/Cargo.toml --workspace --locked --no-fail-fast
python3 rust/scripts/check-boundaries.py --self-test
PATH="$(dirname "$node_bin"):$PATH" \
  python3 .cursor/skills/verify-print-partner-rust/helpers/verify.py
```

`verify-rust.log` contains the full final-head skill output, including build, authenticated health/runtime/HTML, persisted Source create/read and successful cleanup. `enforced-launch-receipt.json` covers environment removal and package confinement for initial/restarted real servers plus missing/changed/escaping preload rejection.

The original merge was reviewed with git show --cc and both parent comparisons. The accepted-media-cache file still exactly matches main 0946f74c, including #179's nlink ctime exception. The runtime state audit includes Stopping and Failed. No separate desktop UI/status-screen state match, installed-bundle test, or macOS bundle workflow exists on this branch. The unsigned macOS helper cannot establish macOS runtime/signing/install evidence. The preceding round's complete audit is linked in merge-and-state-audit.json.
