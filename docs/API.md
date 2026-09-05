# HTTP API

Print Partner serves JSON APIs, browser routes, downloads, and WebSockets from the same Fastify server. This page explains the stable entry points and conventions. The generated OpenAPI document is the source of truth for individual request and response schemas.

## Entry points

| URL | Purpose |
|-----|---------|
| `GET /health` | Health, version, database state, and release identity |
| `GET /api/v1` | API discovery |
| `GET /api/v1/openapi.json` | OpenAPI 3.1 document |
| `GET /api/v1/docs` | Swagger UI outside production, or when `OPENAPI_UI=1` |
| `POST /api/v1/mcp` | Streamable HTTP MCP |
| `GET /metrics` | Prometheus metrics |

Example:

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/api/v1
```

## Authentication

Self-host mode can run without user accounts on a trusted loopback or LAN deployment. Set `PRINT_PARTNER_API_KEY` before exposing API or MCP access beyond the host.

Send the key with either header:

```http
X-Print-Partner-Api-Key: <key>
```

```http
Authorization: Bearer <key>
```

Multi-user mode uses the login session for browser requests and applies tenant boundaries to stored records. Administrative routes can require an API key even when the browser session is valid.

## API families

Print Partner contains three route families:

| Family | Role |
|--------|------|
| Unprefixed routes | Browser-facing application operations and downloads |
| `/api/v1` | Integration API, MCP, job discovery, and legacy Plan summary shapes |
| `/api/v2` | Current typed Plan summary contract |

Some operations are available both unprefixed and under `/api/v1` because the browser application predates the versioned API. Use the typed endpoint definitions in `web/apps/web/src/api/endpoints` when adding browser calls. External integrations should prefer `/api/v1` or `/api/v2` and consult OpenAPI.

## Main resources

### Sources

Source routes register, update, sync, inspect, and search Git repositories, local directories, and uploaded archives.

Common paths include:

```text
GET    /sources
POST   /sources
GET    /sources/:id
PATCH  /sources/:id
DELETE /sources/:id
GET    /sources/:id/stl-tree
GET    /sources/stl-search
GET    /sources/:id/docs
PUT    /sources/:id/import-rules
POST   /jobs/sync
```

Sync and scanning operations use background jobs when the work may outlive one request.

`local_path` is an operator-facing capability for trusted, single-tenant
self-host deployments. SaaS and multi-user deployments reject it on Source
create and update requests, confine content to the Source's managed workspace,
and return `local_path: null`. Clients must use the `content_available` boolean
to decide whether Source files and documents are available.

### Builds and Plans

The API retains the historical `plans` resource name for Builds.

```text
GET    /plans
POST   /plans
GET    /plans/:id
PATCH  /plans/:id
DELETE /plans/:id
POST   /plans/:id/duplicate
POST   /plans/:id/archive
GET    /plans/:id/drafts
POST   /plans/:id/drafts/recompute
POST   /plans/:id/drafts/:draftId/apply
```

Applying a draft creates the accepted Plan revision used by Checkoff and Production. Callers should not update accepted state by patching part rows directly.

Production Setup is a Build-owned resource:

```text
GET   /plans/:id/production-setup
PATCH /plans/:id/production-setup
```

Each `PATCH` body is one typed command: `set_preferred_slicer_instance`,
`set_selection`, `replace_printer_assignments`, `set_route`, or
`replace_rules`. Read the returned resource after a `409` conflict before you
retry. The former full-record `PUT` operation was removed; clients that used it
must send the corresponding field commands instead.

### Checkoff

```text
GET   /plans/:id/checkoff
PATCH /parts/:id/progress
GET   /parts/:id/assembled
PATCH /parts/:id/assembled
POST  /plans/:id/progress/import
```

Printer completion does not mark units complete without review. The printer checkoff routes record the host result, then accept a confirm or reject decision.

### Plates and exports

```text
GET   /plans/:id/plates
POST  /plans/:id/plates/initialize
POST  /plans/:id/plates/arrange
POST  /jobs/export-accepted-plate-3mf
POST  /jobs/export-direct-3mf
POST  /jobs/export-stl-pack
GET   /exports/*
```

Export jobs return a job id. Completed jobs provide an artifact URL under `/exports/`.

### Printers and integrations

```text
GET    /printers
POST   /printers
PUT    /printers/:id/details
DELETE /printers/:id
GET    /integrations
POST   /integrations
PATCH  /integrations/:id
POST   /integrations/:id/test
GET    /integrations/:id/status
POST   /printer-send-queue
```

Printer fleet entries describe planning geometry. Integration records hold the host connection and capability configuration. Link the two instead of placing secrets on a fleet entry.

See [Printer setup](integrations/PRINTER_SETUP.md).

### Backups and storage

Backup routes are administrative, unprefixed browser API operations:

```text
GET    /backups
POST   /backups
GET    /backups/storage
GET    /backups/:name
GET    /backups/:name/preflight
POST   /backups/validate
POST   /backups/restore
DELETE /backups/:name
```

Use `GET /backups/storage` to read the logical-byte inventory and estimated
backup contents. Use the preflight endpoint before restoring a stored archive.
Uploaded archive validation returns the same restore preflight with its backup
metadata. Restore repeats archive and capacity checks immediately before it
extracts data. It returns `507` without closing SQLite when the data filesystem
does not have the required free space.

Backup uploads accept at most 20 GiB of compressed data. Archive validation
also limits expanded content to 20 GiB, one entry to 8 GiB, the archive to
100,000 entries, and the expansion ratio to 200:1. `POST /backups` validates the
completed archive against the same restore policy before it publishes the file.

Format v2 metadata declares either `scope.kind: "database-only"` with no
included roots or `scope.kind: "full"` with all 11 durable roots. The full scope
includes Source revisions, Working Source files, generated media and exports,
Assistant knowledge, manifest and kit configuration, custom filaments, and
`path-hints.yaml`. A full restore treats an absent scoped path as absent state;
a database-only restore leaves those paths unchanged. Format v1 archives keep
their compatibility behavior and replace only legacy roots that are present.

See [Operations](../OPERATIONS.md) for the restore procedure and concurrency
limits.

## Background jobs

A background operation returns:

```json
{
  "job_id": "<uuid>"
}
```

Read its state with:

```text
GET /jobs/:id
GET /api/v1/jobs
```

The browser subscribes to `GET /ws/jobs/:jobId` for progress. Clients that do not use WebSockets may poll the job route.

Do not retry a mutating job blindly after a timeout. Read the job or remote printer state first so a retry does not create a duplicate export or print start.

## Errors

JSON errors include a human-readable `detail` field:

```json
{
  "detail": "Plan not found"
}
```

Some routes also include `title` or a machine-readable `code`. Treat unknown fields as additive.

Typical status codes:

| Status | Meaning |
|--------|---------|
| `400` | Invalid request or state transition |
| `401` | Missing or invalid credentials |
| `403` | Authenticated but not allowed |
| `404` | Resource not found |
| `409` | Revision or state conflict |
| `413` | Upload exceeds the configured limit |
| `507` | Data filesystem has insufficient space for restore |
| `429` | Rate limit exceeded |
| `500` | Unexpected server error |

## MCP

MCP uses the same domain operations as the application API. Read tools return product state. Mutating tools create a proposal that must be applied with `confirm_apply`.

Use streamable HTTP MCP on the running server:

```text
http://127.0.0.1:8080/api/v1/mcp
```

See [MCP setup](assistant-mcp.md) for client configuration and the confirmation flow.

## Browser route fallback

In the single-port Docker build, browser navigation to paths such as `/plan` or `/progress` returns the SPA document. JSON requests to API paths keep their JSON response. Reverse proxies must preserve browser navigation headers, including `Sec-Fetch-Mode` or an `Accept` header containing `text/html`.
