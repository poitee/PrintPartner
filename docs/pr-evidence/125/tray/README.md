# Tray close/show/quit evidence at 11f1d0b2

Source head: `11f1d0b2d2d4e9ca9acbd739c7bf3abc2e02a48c` (confirmed before build, during capture and after capture). Evidence only; native source was not modified. Built pp-desktop dev profile from this head with the SHA-bound staged runtime. No `--test-exit-seconds` flag, mock server, simulated tray, or browser substitute was used.

Environment: Ubuntu 26.04.1 LTS x86_64; kernel 7.0.0-38-generic; Rust/cargo 1.99.0; Node 24.21.0 (ABI 137); GTK3 3.24.52; WebKitGTK 4.1 / 2.52.6. No existing desktop/tray host was available. Used real Xvfb `:125` at 1440x1000x24, Openbox, tint2's XEmbed tray and libayatana-appindicator fallback in a private dbus-run-session. Software rendering: WEBKIT_DISABLE_COMPOSITING_MODE=1 and LIBGL_ALWAYS_SOFTWARE=1. HOME and XDG directories were isolated under `/tmp/pp125-tray-11f1d0b2/home`; disposable data was `/tmp/pp125-tray-11f1d0b2/data`. Package versions are in environment-packages.txt.

## Exact journey and commands

Build and launch commands are in [commands.sh](commands.sh). The full executable capture is [capture-tray.py](capture-tray.py); [process-exit.log](process-exit.log) contains each interaction, command, output and assertion. The tint2 configuration was extracted from d77498c:docs/pr-evidence/125/tint2rc as instructed.

1. Start Xvfb in a live terminal session, then `DISPLAY=:125 PP_EVIDENCE_REPO="$PWD" dbus-run-session -- python3 /tmp/pp125-tray-11f1d0b2/capture-tray.py`. The script starts Openbox and tint2, launches `rust/target/debug/pp-desktop --dev-stage /tmp/pp125-tray-11f1d0b2/runtime --data /tmp/pp125-tray-11f1d0b2/data`, and waits for the real tray's `Service ready` label and mapped native window. Ready screenshot: 01-native-ready.png.
2. Record marker, lease directory, socket and `ps -p 271105,271161 -o pid,ppid,stat,etime,args`. App PID 271105; staged Node child PID 271161; native window XID 8388611.
3. Close through the window manager: `xdotool windowactivate --sync 8388611 key alt+F4`. After three seconds, `xdotool search --onlyvisible --name '^Print Partner$'` returns no window (exit 1); both app and Node remain in ps. Capture the full X root with `import -display :125 -window root /tmp/pp125-tray-11f1d0b2/02-closed-tray-only.png`. It shows the actual tray icon and no app window.
4. Open the real tray menu: `xdotool mousemove 1418 982 click 3`. Capture 03-tray-menu.png. Read its real `com.canonical.dbusmenu.GetLayout`; labels include Show Print Partner, Service ready, disabled Restart service, Quit Print Partner.
5. Press Escape to dismiss the menu. Invoke its exported Show item using Gio DBus `Event` with signature `(isvu)`, `(2, 'clicked', variant int32 0, uint32 0)` on service `:1.2`, path `/org/ayatana/NotificationItem/tray_icon_tray_app_printpartner/Menu`, interface `com.canonical.dbusmenu`. This is the real menu event handler. XID 8388611 maps again; capture 04-restored-window.png and repeat ps (same PIDs).
6. Open/capture the real menu again (05-tray-quit-menu.png), dismiss it and invoke Quit with the same Event signature and item ID 5. `subprocess.Popen.wait(timeout=30)` returns **0**. Neither captured PID appears in ps (exit 1); `/proc/271161` is absent. `.desktop-owner.json`, `.desktop-lease`, `/persist/tmp/pp-271105-030dff427274aac1` and its `22c661c6f5b7.sock` are absent. Full receipt is in native.stdout.log. Capture 06-after-quit.png before stopping only the capture-owned WM, tray panel and Xvfb.

## Observed cleanup and explicit limitation

```json
{"proof_class":"headless_unsigned","compat_reaped":true,"storage_released":true,"gateway_stopped":true,"marker_removed":true,"runtime_removed":true,"errors":[]}
```

**The persistent `.desktop.lock` file is not removed by this implementation.** Its OS lock is released: Python `fcntl.flock(probe, LOCK_EX | LOCK_NB)` succeeds after quit. The marker, lease and socket are removed and the child is reaped. Literal lock-file deletion is therefore not demonstrated and should not be claimed. The capture deliberately does not manually delete it to make cleanup appear complete.

This proves the Linux native debug build and actual Linux tray behavior on a virtual X display. It does not establish macOS/Windows or installed/signed bundle behavior. Show and Quit were activated by the real exported DBus menu events, rather than pointer-clicking the menu rows; the menu itself was opened with a real tray right-click and captured.

The first attempted launch could not initialize GTK because the initial background Xvfb process did not survive its terminal command. Those logs are retained in first-attempt/. The successful complete run used Xvfb held in a live exec session. No unsuccessful screenshots or prior-head screenshots are represented as successful evidence.

SHA256SUMS records the built native executable and the six unedited full-display PNGs. Original files remain at `/tmp/pp125-tray-11f1d0b2`; durable evidence copy at `/persist/tmp/pp125-tray-11f1d0b2`.
