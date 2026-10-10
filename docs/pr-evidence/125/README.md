Source head: `9fea133c96f161cff4a7cc4ddb1504dd1862251d`

These screenshots show the actual debug `pp-desktop` process, its GTK/WebKit window, real Rust core and staged Node compatibility server on an isolated local Linux display. No browser substitute or mocked runtime state was used. All writes used disposable directories. No .80 or .81 host was used.

`native-ready.png` shows Builds after the private native bootstrap. The three `tray-*.png` screenshots show the actual tray menu. `native-events.json` records the live DBus menu labels and source commit. `native.stdout.log` records successful close/hide and show behavior, followed by the expected conservative cleanup-failure receipt. The fault run exited 1. `native-normal.stdout.log` records a separate successful timed native run: exit 0, hide/show true, complete shutdown, marker and runtime directory removed, storage released.

Reproduce from the source head with Rust 1.99.0, Node 24.21.0, Linux GTK3/WebKit 4.1 development libraries, Xvfb, openbox, tint2, xdotool, Python PyGObject and dbus-run-session:

```sh
# Run from the source checkout root. Copy this archive's capture-native.py and
# tint2rc into the new evidence directory before the capture command.
evidence_dir=$(mktemp -d /tmp/pp125-evidence.XXXXXX)
node_bin=$(readlink -f /usr/bin/node)
npm --prefix web ci
VITE_PRINT_PARTNER_DESKTOP=1 npm --prefix web run build
python3 rust/scripts/stage-desktop.py --web web --node "$node_bin" \
  --output "$evidence_dir/runtime" --commit "$(git rev-parse HEAD)"
PP_DESKTOP_RELEASE_MANIFEST="$evidence_dir/runtime/bundle-manifest.json" \
  cargo build --manifest-path rust/Cargo.toml --locked -p pp-desktop
Xvfb :125 -screen 0 1440x1000x24 -nolisten tcp &
display_pid=$!
DISPLAY=:125 dbus-run-session -- python3 "$evidence_dir/capture-native.py" --repo "$PWD"
DISPLAY=:125 WEBKIT_DISABLE_COMPOSITING_MODE=1 LIBGL_ALWAYS_SOFTWARE=1 \
  dbus-run-session -- rust/target/debug/pp-desktop \
  --dev-stage "$evidence_dir/runtime" --data "$evidence_dir/normal-data" \
  --test-exit-seconds 3
kill "$display_pid"
```

The capture script opens the real tray menu, suspends only its own Node child with SIGSTOP, waits for three real health failures, and captures Stopping during the supervisor's ten-second reap window. It then renames the isolated Unix socket and places a directory at its former path, inducing the same cleanup failure as `cleanup_error_publishes_failed_and_preserves_failure`. It captures Failed, removes its injected socket obstacle, and terminates its app. The debug timed argument avoids a blocking fatal-error dialog; it does not inject runtime states. A nonzero exit and `compat_cleanup_unproved` are expected for this fault, and Restart remains disabled. The separate normal run proves the complete exit path.

Validation commands:

```sh
python3 rust/scripts/build-desktop-manifest.py --web web --node "$node_bin" \
  --output rust/bundle-manifest.json --commit "$(git rev-parse HEAD)"
cargo fmt --manifest-path rust/Cargo.toml --all --check
cargo clippy --manifest-path rust/Cargo.toml --workspace --all-targets --locked -- -D warnings
cargo nextest run --manifest-path rust/Cargo.toml --workspace --locked --no-fail-fast
python3 rust/scripts/check-boundaries.py --self-test
npm --prefix web test
PATH="$(dirname "$node_bin"):$PATH" \
  python3 .cursor/skills/verify-print-partner-rust/helpers/verify.py
```

Generate the default `rust/bundle-manifest.json` with the actual pinned Node executable before the Rust checks. Keep web builds and manifest generation sequential with Cargo test builds. The fleet's `/opt/agent-fleet/bin/node` is a shell wrapper; the runtime tests default to `/usr/bin/node`. An initial test attempt measured the wrapper and correctly failed Node content validation. The final 46/46 run used the matching executable. The final Rust skill run follows those checks and prepends the actual Node directory to PATH.

The complete Rust skill transcript is `verify-rust.log`; it includes its own build output, authenticated health/runtime/HTML reads, persisted Source creation/readback, and successful cleanup. `enforced-launch-receipt.json` proves NODE_OPTIONS/NODE_PATH removal and package confinement for initial and restarted real servers, with unguarded sentinel controls plus missing/changed/escaping preload rejection before database or owner creation.

The merge was inspected with `git show --cc d2daeed9` and comparisons against both parents. The accepted-media-cache file exactly matches main `0946f74`; the `opened.nlink > 0 && afterRead.nlink === 0` ctime exception is preserved. Core, tray and runtime-test state matches include Stopping and Failed. There is no separate runtime-state desktop status screen or installed-bundle test on this branch. No macOS bundle workflow exists; the unsigned macOS helper does not establish macOS runtime, signing or installation evidence.
