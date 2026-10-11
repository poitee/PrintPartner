# PrusaLink response fixtures

Seven synthetic, sanitized HTTP responses based on the shapes consumed by the
TypeScript PrusaLink adapter and its existing tests. These are compatibility
examples, not captures from a physical printer or an authoritative firmware spec.
They can be reused by the future Rust driver without contacting a printer.

Each JSON file contains an HTTP `status`, response `headers`, and decoded JSON
`body` (`null` for the bodyless Digest challenge). Construct a fresh response for
each request; response bodies are single-use streams.

| Fixture | Request / adapter behavior |
| --- | --- |
| `digest-401.json` | GET `/api/v1/status` challenge; Digest authorization |
| `info.json` | GET `/api/v1/info`; connection label and version metadata |
| `status-idle.json` | GET `/api/v1/status`; READY maps to idle |
| `status-printing.json` | GET `/api/v1/status`; progress, file, ETA, temperatures |
| `status-error.json` | GET `/api/v1/status`; ERROR maps to error |
| `job.json` | GET `/api/v1/job`; active filename and fallback progress / ETA |
| `upload-response.json` | PUT `/api/v1/files/usb/benchy.gcode`; HTTP 201 success |

The existing TS adapter uses `/api/v1/info`, not a separate version endpoint, and
only reads the connection label from that body. It accepts the upload status and
cancels the upload response body without parsing its JSON. Tests preserve those
behaviors rather than changing the adapter to consume additional fields.

Names, the Digest nonce, and credentials in the test are invented. The only host
in the fixtures is `printer.example`; the test uses RFC 5737 `192.0.2.10` with
mocked fetch. No real printer IPs, credentials, or authorization headers are stored.

Run from the repository root:

```sh
cd web && npm run test -w @print-partner/server -- src/integrations/adapters/prusalink.fixtures.test.ts --reporter=verbose
```

The test asserts the complete seven-file inventory and reports `7 PrusaLink
fixtures` in the Vitest suite name, with one adapter test per fixture.
