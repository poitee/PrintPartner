# Desktop app

`pp-desktop` is the Print Partner desktop app. It is a Tauri window and tray around the Rust core. This page will cover install, the data location, logs and network sharing. Most of it is a stub until the desktop milestone lands.

## Platforms

macOS ships first. Windows and Linux ship before 1.0. CI will build and test the app on all three (GRE-632).

## Behavior today

- Closing the window hides it to the tray. The core keeps running.
- The tray has Show, the service status, Restart service and Quit.
- Quit waits for the core to shut down before the process exits.
- The default data directory is `~/.print-partner`. See [Storage](storage.md).
- The web view gets no native commands. Navigation stays on the core's loopback origin, and popups are denied.

[pp-desktop/README.md](../rust/crates/pp-desktop/README.md) describes how to run the development app. [ADR 0005](adr/0005-desktop-product-identity.md) records the product identity.

## Share on network

The "Share on network" setting is off by default. When it is on, phones, tablets and other computers can use the web UI after they sign in or pair. See [Network sharing](network-sharing.md).

## To be written

- Install and update steps for each OS.
- Data location for each OS, and how to move it.
- Where logs live and how to read them.
- Settings, autostart and the first-run wizard.
- Crash reporting, which is opt-in and off by default.

## Evidence for desktop changes

A PR that changes the desktop app attaches captures from the real app built at the PR head. [Gate evidence](contributing/gate-evidence.md#desktop-and-tray-capture) describes the steps.
