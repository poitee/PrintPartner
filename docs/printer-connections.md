# Optional printer connections

New printers default to manual use. Their bed size and model can be used for planning and file export without a network connection. Checkoff can record uploaded print files without monitoring a printer.

In Settings, leave **Connect to this printer** unchecked for manual use. Check it to open connection setup after adding the printer, then enter and save the connection details. An existing manual printer offers **Add connection** for the same setup.

For an already connected printer, **Communication enabled** controls its saved connection. Turn it off to stop status polling and disable connection testing. The connection details remain available for re-enabling. This change does not disable previously configured connections automatically.

Checkoff and the Printers page load connection settings only when the fleet contains an enabled printer linked to a connection. Authentication errors from an explicitly configured connection remain visible. Manual-only fleets do not need those connection settings.

## Verification

Start the isolated backend with `node --conditions=development --import tsx scripts/plan-save-benchmark.mts --serve` from `web/`. In another terminal, also from `web/`, run:

```sh
VITE_DEV_API_TARGET=http://127.0.0.1:5182 npm run dev -w @print-partner/web -- --host 127.0.0.1 --port 5176
```

Run `node scripts/check-manual-printers.mjs` from `web/`. The check adds a manual test printer to the isolated fixture, makes any attempted connection-settings request fail with HTTP 401, and requires zero connection or reconciliation requests on Checkoff and the Printers page. It does not modify the live fleet.
