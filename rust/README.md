# Protected runtime foundation

The [desktop rebuild flag](../docs/desktop-rebuild.md) gates the GRE-595 rebuild and defaults to off.

The Rust lint ratchet runs with ast-grep 0.50.0:

```sh
ast-grep test --config rust/sgconfig.yml --skip-snapshot-tests
python3 rust/scripts/test_ast_grep.py
python3 rust/scripts/check-ast-grep.py
```

The ratchet fails unless every rule's hit count equals its entry in `rust/ast-grep-baseline.json`. Fewer hits also fail until the baseline is lowered in the same change. Deleted, disabled, unbaselined, or unloaded rules and scanner errors fail closed.

The baseline may not rise over `origin/main`'s `rust/ast-grep-baseline.json`. A rule absent from main's baseline counts as zero. To raise a baseline intentionally, set `PP_AST_GREP_ALLOW_BASELINE_RAISE=1` for that check and document the reason in the change. The override relaxes only the rise check; counts must still equal the baseline. If `origin/main` has no baseline file yet (the first landing), the rise check is skipped and the gate prints that it was skipped. A missing `origin/main` ref is an error, so fetch it first (`git fetch origin main`).

Use the Python gate for production counts. It canonicalizes non-keyword raw
identifier AST nodes in temporary copies before checking process aliases, so
`r#p` and `p` share provenance and shadowing. Strings, comments, source files,
and other rules retain their original text. Diagnostics use original source
spelling and byte positions. Qualified `self`, `crate`, and single-parent
`super` aliases resolve module imports rather than block-local bindings.

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
python3 rust/scripts/check-domain-deps.py --self-test
cargo fmt --manifest-path rust/Cargo.toml --all --check
cargo clippy --manifest-path rust/Cargo.toml --locked --workspace --all-targets -- -D warnings
```

The Python proofs expect `/usr/bin/node` and the built server binary. They create fresh temporary directories and retain redacted receipts and databases for inspection. The local STL fixture is copied from the accepted Plate export baseline fixture. They never configure a printer or import production data. `runtime_m0` includes real Node children, actual 61-second bootstrap expiry, persisted-origin reuse, failed bind, wrong release, copied-artifact tampering, cleanup failure, Drop after caller runtime teardown and the crash guard. It needs the built Node server and React assets first. To check scratch cleanup as Desktop runtime CI does, run it with `--test-threads=1` and `TMPDIR` set to a new empty directory; the directory must still be empty afterwards.

The launcher takes `--data`, `--web`, `--node` and `--commit`. It prints only the clean origin. Automated fixtures may explicitly request `--test-credential-file` to receive the one-use bootstrap URL in a newly created 0600 file. Treat that file as a credential and delete it after use. The native shell takes the same launch capability directly from CoreRuntime. Its default store is `~/.print-partner`, reusing existing desktop data in place. Startup failures print allowlisted diagnostic codes and OS error numbers to stderr before showing the error dialog; arbitrary paths, URLs and backend error payloads are omitted.

The persisted `desktop.toml` must be a readable regular file of at most 4096 bytes. CoreRuntime refuses symbolic links, including dangling links, and non-regular files before it starts Node. Missing configuration selects and atomically persists a loopback port. Corrupt configuration fails startup without replacing the configuration. Only an occupied valid saved port triggers recovery. CoreRuntime holds a new loopback listener while it durably replaces the saved port, before starting Node. `origin_change()` exposes immutable `OriginChange::PersistedPortInUse` disclosure with a credential-free display notice. Missing and reused origins carry no disclosure. Publication failure aborts startup and closes the selected listener. Failures before rename preserve the old bytes. Directory sync failure after rename can leave the complete new port file. The `ticket_t_12` core tests exercise the actual storage lease and listener, including FIFO admission in a bounded child process. This hardening uses the existing runtime path with either rebuild flag setting. Launcher integration with per-OS paths remains follow-up work.

CoreRuntime controls one dedicated owner thread with its own Tokio runtime. That thread owns the gateway, supervisor and storage lease through cleanup. Dropping CoreRuntime signals this thread even after the caller runtime has been destroyed. Consuming shutdown awaits cleanup and joins the owner thread. Its receipt reports child reap, process-group absence, removal of the compatibility reservation and runtime directory, and release of the owner's storage descriptor. Failures are returned and the launcher exits unsuccessfully. If writer death is unproved, ownership remains conservatively held.

Before a same-process restart, Core retries any retained failed storage release whose writer closure was proved. Startup fails while cleanup is still incomplete, and releases retained because closure was unproved remain blocked until process exit. A new lease is acquired only after the retry completes.

Rust acquires the advisory `printpartner.lock` before database preflight and holds it through database closure and child reaping, including supervised Node restarts. The child inherits that locked descriptor and a private parent-liveness pipe. Rust also reserves `.desktop-lease` with a regular file while holding the lock. Standalone Node publishes a directory at that name, so either runtime blocks the other before opening storage. Rust refuses an existing Node lease directory without inspecting or recovering its contents. After a Rust crash, the kernel releases the advisory lock and the next Rust instance can reuse the remaining regular reservation. Orderly cleanup removes that reservation before releasing the lock, and only if its device and inode still match the acquired file. Rust does not use owner markers or PID-based recovery. The lock file stays on disk, and its presence does not indicate ownership. Pre-GRE-636 Rust executables do not cooperate with this protocol. See [Storage](../docs/storage.md) for compatibility and unsupported directory operations.

The generated manifest measures Node, every frontend and backend build file, compiled contracts/domain files and package metadata. Rust embeds that inventory at compile time and measures the selected files before acquiring storage. It measures the backend again before every child restart. Missing, changed or extra build files fail closed. `PP_DESKTOP_RELEASE_MANIFEST` can select the package builder's manifest at Rust compile time; manifests contain relative artifact paths so resource trees can move. Generate the manifest again only after an intentional build, then rebuild Rust. It does not measure the entire node_modules dependency closure; that remains a native staging requirement. These hashes detect stale or changed bundles. Publisher trust still requires native signing and installed-file permissions.

Operation ownership is immutable per launch. The checked-in gateway manifest admits an initial subset of exact route patterns and explicitly marks Checkoff GET repair as a write. Node owns startup migrations, workers, receipts and file publication. Unregistered routes return JSON 404. MCP stays disabled until valid-key behavior is implemented and verified. Existing accounts require explicit owner mapping and are refused by the compatibility launcher.

The gateway also streams staged SPA assets in chunks of at most 64 KiB. Asset bodies retain request admission until dropped and stop when the gateway cancels responses. GET and HEAD share content types and lengths, and other asset methods return 405. SPA navigation HEAD requests use the same deep-link allowlist as GET. Authentication, path containment and no-store caching still apply. This hardens the existing runtime without enabling `desktop_rebuild`; it does not embed or precompress the SPA.

Run `cargo nextest run --locked --manifest-path rust/Cargo.toml -p pp-gateway -E 'test(ticket_t_11)'` after providing the measured bundle manifest described above. The tests include a slow TCP reader, another simultaneous request and bounded shutdown. They use a gateway with no published Node endpoint and do not prove native packaging or Rust job cutover.

The gateway forwards bodies once and streams responses. An uncertain mutation response is never replayed by Rust. The workflow proof commits an autosave while its client leaves the response unread, kills only Node, and retries the same command/key after restart. It checks one new immutable Plan revision, Checkoff state and authenticated export bytes.

Logs keep only approved event names, severity and timestamps. Raw Node output, URLs, error chains and payloads are discarded during projection. Files rotate at 10 MB or a day boundary, retaining seven files. This deliberately limits diagnostics until richer safe fields have their own tests.

The loopback document carries `frame-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`. Existing blob thumbnails/downloads and popup-based handoffs are preserved. This CSP does not deny popups; the native shell must deny new windows separately.

Browser interaction, native window permissions, macOS WebKit cookies, signed/notarized packaging and installed-app process behavior remain separate acceptance requirements. Job WebSocket path/reconnect work is owned by another worker; the gateway supports upgrade relay but that journey is not proved by these tests. Slow-consumer stress, steady-health three-failure timing and broader operation admission remain follow-up verification work.

## Moonraker status seed (GRE-335)

The desktop gateway starts status monitoring independently of browser requests
and window visibility. Node retains storage ownership and provides a private,
signed-principal-only UDS snapshot of Moonraker configuration. That endpoint is
not admitted through the public gateway. Snapshot reconciliation runs once per
second, has an independently bounded two-second queue wait and two-second Node
read (at most four seconds total before reconciliation), and also runs after successful integration
creation/update/removal. At most 128 Moonraker configurations are admitted.
Malformed or denied snapshots cancel monitoring immediately. If Node is slow or
unavailable, the last-known-good pollers keep running for a 10-second grace
period and are then stopped. The status route serves cached Moonraker status.
Ids that are not in the last valid snapshot (PrusaLink, Bambu, Home Assistant)
are forwarded straight to Node without waiting. When no valid snapshot exists,
or a known Moonraker host has no running poller, the route refreshes once and
otherwise returns 503. It never falls back to Node's on-demand path for a plain
HTTP Moonraker host.

`pp-drivers` owns one task per enabled host and serves the existing optional-field
`PrinterHostStatus` DTO from `pp-api-types` at the admitted v1 status route. A
successful poll waits two seconds. A new poller reports `unknown` "Awaiting
status" until its first poll. Errors mark the host offline with a fixed message,
which keeps the HTTP status code (for example "Moonraker returned HTTP 401"),
and back off from four to sixty seconds. Reconciliation joins removed/replaced tasks before
starting replacements. Core shutdown cancels and joins monitoring. Native power
adapters can await `CoreHandle::suspend_monitoring()` before sleep and call
`resume_monitoring()` on wake; hiding the window never suspends monitoring.
OS-specific power notification delivery has not been proved here.

Both GET and HEAD status requests use the cache; HEAD returns no body.
Snapshot reads use a separate reconciliation lock so cached reads do not wait
for Node. The bounded snapshot transport covers worst-case JSON escaping of
all accepted host fields.

Each status poll makes only a GET to `/printer/objects/query`. This seed omits
system uptime, which requires a separate Moonraker endpoint; the printer page
hides the uptime row when that optional field is absent. `pp-net` resolves
once per request, rejects the entire answer set if any address is prohibited,
and connects using checked `SocketAddr` values without another resolution.
Explicit LAN and loopback printer targets are allowed. Metadata, link-local,
unspecified, multicast and IPv6 transition/translation targets are rejected.
HTTP requests have five-second monotonic and wall-time deadlines (sleep must
not extend a socket's life), at most 32 DNS answers and a 2 MiB response limit.
Redirects are not followed. This seed supports explicit HTTP; HTTPS/TLS provider
work belongs to GRE-359. Until then, HTTPS hosts and hosts that answer with a
redirect stay on Node's existing on-demand status path, which supports HTTPS
and SSRF-checked redirects. API-key/JWT headers stay on the configured connection.

Monitoring has no database, Checkoff, upload or dispatch dependencies. Node's
other printer operations retain their existing behavior. Simulator fixtures and
the real gateway test cover successful, printer-error and offline responses,
cancellation, backoff, duplicate prevention, DNS rebinding and trust boundaries:

```sh
cargo nextest run --locked --manifest-path rust/Cargo.toml --no-tests=fail -E 'test(ticket_t_4) | test(gre_335)'
```

GRE-449 and controlled hardware/native-window/power evidence remain separate
completion gates. These seed receipts do not mark GRE-335 or its parent Done.

`CoreHandle::browser_preferences` and `set_browser_preference` read and update typed preferences through bounded owner commands. The existing storage lease owns the port-independent `browser-preferences.json` sidecar. Its version 1 JSON admits only sidebar collapse, system/light/dark theme, and printer poll intervals of 5, 10, 15, or 30 seconds. Per-field `None` clears that field while preserving the others. Missing files return an empty snapshot. Unsafe files, unknown fields, unsupported versions, invalid values, and files larger than 4096 bytes fail without overwrite. Shutdown closes admission and settles queued commands before releasing storage.

These library APIs preserve saved sidecar values and unrelated store bytes across origin changes, restarts, and copied portable stores. They do not open, move, or rewrite product databases. Browser capture and restore remain unwired until GRE-368, so existing webview localStorage and IndexedDB do not migrate. The shell does not show the origin-change notice yet. Every runtime still requires its fresh gateway bootstrap, without a user login or credential clearing on port changes.
