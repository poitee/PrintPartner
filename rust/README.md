# Protected runtime foundation

This workspace runs the existing React application behind a Rust loopback gateway. The real Node compatibility server owns all admitted domain operations and listens only on a private Unix socket. This is an unsigned Linux proof. It is not a Tauri build or a Rust-only backend release.

Use Rust 1.99.0 and Node 24.21.0. From the repository root:

```sh
npm --prefix web ci
VITE_PRINT_PARTNER_DESKTOP=1 npm --prefix web run build
python3 rust/scripts/build-desktop-manifest.py --web web --node /usr/bin/node --output rust/bundle-manifest.json --commit "$(git rev-parse HEAD)"
cargo build --manifest-path rust/Cargo.toml --locked -p pp-server
cargo test --manifest-path rust/Cargo.toml --locked -p pp-core --test runtime_m0 -- --nocapture
python3 rust/tests/workflow_m0.py
python3 rust/tests/lifecycle_m0.py
python3 rust/scripts/check-boundaries.py --self-test
cargo fmt --manifest-path rust/Cargo.toml --all --check
cargo clippy --manifest-path rust/Cargo.toml --locked --workspace --all-targets -- -D warnings
```

The Python proofs expect `/usr/bin/node` and the built server binary. They create fresh temporary directories and retain redacted receipts and databases for inspection. The local STL fixture is copied from the accepted Plate export baseline fixture. They never configure a printer or import production data. `runtime_m0` includes real Node children, actual 61-second bootstrap expiry, persisted-origin reuse, failed bind, wrong release, copied-artifact tampering, cleanup failure, Drop after caller runtime teardown and the crash guard. It needs the built Node server and React assets first.

The launcher takes `--data`, `--web`, `--node` and `--commit`. It prints only the clean origin. Automated fixtures may explicitly request `--test-credential-file` to receive the one-use bootstrap URL in a newly created 0600 file. Treat that file as a credential and delete it after use. The native shell takes the same launch capability directly from CoreRuntime. Its default store is `~/.print-partner`, reusing existing desktop data in place. Startup failures print allowlisted diagnostic codes and OS error numbers to stderr before showing the error dialog; arbitrary paths, URLs and backend error payloads are omitted.

CoreRuntime controls one dedicated owner thread with its own Tokio runtime. That thread owns the gateway, supervisor and storage lease through cleanup. Dropping CoreRuntime signals this thread even after the caller runtime has been destroyed. Consuming shutdown awaits cleanup and joins the owner thread. Its receipt measures child reap, process-group absence, marker/directory cleanup and lock reacquisition; failures are returned and the launcher exits unsuccessfully. If writer death is unproved, ownership remains conservatively held.

Rust owns an OS data-directory lock. The child inherits that locked descriptor and a private parent-liveness pipe. Rust and standalone Node entry points share a filesystem lease: a prepared nonempty directory is atomically renamed into place before inspecting or creating the owner marker. Rust additionally holds its OS lock, inherited by the child. The marker is kept until database closure. An unmodified legacy executable does not cooperate with this protocol. After an abrupt crash, acquisition removes a remaining marker only under that lease and when its PID is absent or its boot ID/process start time differs. Live matching identities and uncheckable owners remain blocked; Node preserves Rust markers. Stale leases are atomically renamed to generation-specific nonempty retired directories, retained to prevent competing stale observers from retiring a new lease. These small directories contain only ownership metadata.

The generated manifest measures Node, every frontend and backend build file, compiled contracts/domain files and package metadata. Rust embeds that inventory at compile time and measures the selected files before acquiring storage. It measures the backend again before every child restart. Missing, changed or extra build files fail closed. `PP_DESKTOP_RELEASE_MANIFEST` can select the package builder's manifest at Rust compile time; manifests contain relative artifact paths so resource trees can move. Generate the manifest again only after an intentional build, then rebuild Rust. It does not measure the entire node_modules dependency closure; that remains a native staging requirement. These hashes detect stale or changed bundles. Publisher trust still requires native signing and installed-file permissions.

Operation ownership is immutable per launch. The checked-in gateway manifest admits an initial subset of exact route patterns and explicitly marks Checkoff GET repair as a write. Node owns startup migrations, workers, receipts and file publication. Unregistered routes return JSON 404. MCP stays disabled until valid-key behavior is implemented and verified. Existing accounts require explicit owner mapping and are refused by the compatibility launcher.

The gateway forwards bodies once and streams responses. An uncertain mutation response is never replayed by Rust. The workflow proof commits an autosave while its client leaves the response unread, kills only Node, and retries the same command/key after restart. It checks one new immutable Plan revision, Checkoff state and authenticated export bytes.

Logs keep only approved event names, severity and timestamps. Raw Node output, URLs, error chains and payloads are discarded during projection. Files rotate at 10 MB or a day boundary, retaining seven files. This deliberately limits diagnostics until richer safe fields have their own tests.

The loopback document carries `frame-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`. Existing blob thumbnails/downloads and popup-based handoffs are preserved. This CSP does not deny popups; the native shell must deny new windows separately.

Browser interaction, native window permissions, macOS WebKit cookies, signed/notarized packaging and installed-app process behavior remain separate acceptance requirements. Job WebSocket path/reconnect work is owned by another worker; the gateway supports upgrade relay but that journey is not proved by these tests. Slow-consumer stress, steady-health three-failure timing and broader operation admission remain follow-up verification work.
