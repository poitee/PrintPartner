# Home Assistant adapter fixtures

Synthetic payloads for the Rust port of
`web/apps/server/src/integrations/adapters/home-assistant.ts`. These fixtures
contain no credentials, hostnames, or installation-specific webhook identifiers.

The adapter consumes REST responses, not WebSocket `state_changed` events:

- `api-running*.json`: `GET /api/` connection probe; `version` is optional.
- `state-*.json`: `GET /api/states/{entity_id}` responses, used by the optional
  connection entity check, `getStatus`, and `listDevices`.
- `webhook-response.json`: optional empty JSON response to a successful upload.
  An empty response body also succeeds; the adapter ignores the success body.
- `webhook-upload.json`: JSON descriptor of the outbound `POST
  /api/webhook/{webhook_id}` multipart request. This descriptor is documentation,
  not a JSON body sent over the wire. The `file` part contains file bytes and a
  filename; the separate `filename` field contains the same sanitized name.
  The adapter replaces slashes and backslashes with underscores, trims the
  filename, and defaults an empty name to `print.gcode`. Uploads do not start a
  print and do not send an authorization header.

The connection entity check displays the raw state without mapping it and uses
`unknown` when the state is missing. A 404 fails that check; other HTTP errors
leave the connection successful with an entity-check warning.

For `getStatus` and `listDevices`, state mapping trims whitespace and ignores
case (`state-normalized.json`):

| Raw state | Printer state |
| --- | --- |
| `printing` | `printing` |
| `paused` | `paused` |
| `complete`, `done`, `finished` | `complete` |
| `error`, `failure` | `error` |
| `idle`, `standby`, `ready` | `idle` |
| `unavailable`, `unknown`, empty or missing | `offline` |
| Other nonempty values (`warming_up`) | `unknown` |

`attributes.progress` may be a number or numeric string. The adapter rounds and
clamps it to 0–100 and exposes it only for printing or paused states.
`attributes.filename` is trimmed and retained for any state. Other entity
metadata is ignored. Missing attributes are treated as an empty object.
HTTP errors and network failures have no canonical JSON payload: a missing
entity (404) or unsuccessful status read produces an offline status; an
unsuccessful upload produces a failed result.

Run the TypeScript parsing check from `web`:

```sh
npm run test -w @print-partner/server -- src/integrations/adapters/home-assistant.fixtures.test.ts --reporter=verbose
```

The test discovers every JSON file in this directory and reports the fixture
count in its suite name, including future additions.
