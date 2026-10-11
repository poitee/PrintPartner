# PR #200 (GRE-335) evidence @ 7634da3e

Scope: the Rust Moonraker status watcher served through the desktop gateway, run from the PR head commit `7634da3e270b66e40abe4529385a6868e2257607`. The target was a local loopback mock Moonraker. No real printer was contacted.

## Steps

1. Verified `HEAD` and `gh pr view 200 --json headRefOid` both equal `7634da3e270b66e40abe4529385a6868e2257607`.
2. `npm --prefix web ci`
3. `VITE_PRINT_PARTNER_DESKTOP=1 npm --prefix web run build`
4. `python3 rust/scripts/build-desktop-manifest.py --web web --node <node-24.21.0> --output rust/bundle-manifest.json --commit "$(git rev-parse HEAD)"` (manifest_sha256 `a7f0116a49add54f803be7245b0a460b6741b9f0200a645d1233f5fdf77409fb`)
5. `cargo build --manifest-path rust/Cargo.toml --locked -p pp-server` (Rust 1.99.0)
6. A loopback-only stdlib mock (`evidence/mock_moonraker.py`) listened on `loopback:<mock-port>`. It answers `GET /printer/objects/query` with a three-phase cycle (printing → complete → standby, 20 s each) and logs every request.
7. Launched `pp-server --data <temp-data-dir> --web web --node <node> --commit <head> --test-credential-file <file>` with a temporary data directory. The launcher printed a loopback origin.
8. Opened the app UI in a Chrome app window on display :99 using the one-use bootstrap URL. Each bootstrap token was used once, and the launcher was restarted on the same data directory to issue the next one.
9. Added a printer named "Evidence Mock Printer" in Settings, enabled the connection, and set the Klipper (Moonraker) base URL to `http://loopback:<mock-port>`. The form prefilled a LAN address, which was replaced before saving.
10. Fetched the status route with a cookie jar (curl with `Origin` header):
    `GET /api/v1/integrations/<id>/status`
11. Captured the Printers page with `evidence shot --window "Print Partner"`, then cropped the browser banner and redacted the loopback address value.

## Status JSON (Rust watcher, via the gateway)

Three consecutive responses, 3 s apart, during the printing phase. The `ip_address` value (loopback) is replaced with `<redacted>` here.

```json
{"state":"printing","progress":43.0,"filename":"bracket.gcode","message":"Printing bracket.gcode","ip_address":"<redacted>","nozzle_temperature_c":210.2,"nozzle_target_c":215.0,"bed_temperature_c":59.8,"bed_target_c":60.0}
```

There is no `uptime_seconds` field. The Printers page hides the Uptime row for that reason.

## DB unchanged during polling

Method: the server stayed running, with no admin actions, UI writes or integration changes during the window. The UI remained open on the Printers page. I did not force a WAL checkpoint, because that would itself write to the DB file. Instead I hashed the main DB file and its WAL file, and read row counts through a read-only SQLite URI connection (`mode=ro`). The `-shm` file is volatile and was not hashed.

Window: 50 s, which produced 25 status polls at the mock (about one every 2 s). The mock counter covers the full range for this run, so the snapshot-count delta matches the number of watcher polls in the window.

| Item | BEFORE | AFTER | Result |
|---|---|---|---|
| `print-partner.db` sha256 | `6693fd7f60bb49260e5368b05fa2a01a08b4f22ca5cea63173c8ae04dedc5628` | same | identical |
| `print-partner.db` bytes | 606208 | 606208 | identical |
| `print-partner.db-wal` sha256 | `cca40de922007ccc8db4f070968c069f5cd87abed6957d36305432d8dd006e36` | same | identical |
| `print-partner.db-wal` bytes | 12392 | 12392 | identical |
| Row counts (all tables) | app_settings 4, filament_profiles 4, printer_profiles 2, process_profiles 6, slicer_instances 3, all others 0 | same | identical |
| Mock status polls seen | 64 | 89 | 25 polls in window |

Full before/after snapshots: `db-before.json` and `db-after.json` in this directory.

The mock logged only `GET /printer/objects/query` (123 requests total), so the watcher made no other requests to the mock.

## Screenshot

`pr200-printers-uptime-hidden-7634da3e.png` shows the Printers page with the Rust-watcher status (`Complete`, nozzle 45 °C, bed 35 °C). The Uptime row is hidden. The Address value is redacted, and the caption says so. The browser banner was cropped out.

sha256: `7e33708d5321f9a4909f9dae280f09fcf9df43f9f0f31fe35d7a01d25d2512f6`
