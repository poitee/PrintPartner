# Keep one desktop product identity

Print Partner uses the native application identifier `com.poitee.printpartner` and product name `Print Partner`. The identifier determines platform application storage and signing identity. Keep it stable across the desktop migration.

The React application loads the protected core origin. The native shell owns one main window and tray, exposes no frontend commands, and retains the same data directory while temporary compatibility operations move to Rust. Closing the window hides it. Quitting consumes the core shutdown before process exit.
