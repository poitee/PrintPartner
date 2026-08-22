# Architecture

Print Partner is a TypeScript web application for planning and tracking layered STL kit builds. The supported self-host deployment serves the API and browser app from one container and stores state in SQLite.

## Repository layout

```text
PrintPartner/
├── Dockerfile
├── docker-compose.yml
├── docs/
├── manifests/
├── scripts/
├── slicer-sidecar/
└── web/
    ├── apps/
    │   ├── server/       Fastify API and static file server
    │   └── web/          React and Vite browser app
    └── packages/
        ├── contracts/    Shared request and response types
        └── domain/       Planning, packing, and export rules
```

The root Docker image builds all four workspaces, copies the browser bundle into the server image, and exposes one HTTP port.

## Runtime shape

```text
Browser
   |
   | HTTP and WebSocket
   v
Fastify server
   |-- route handlers
   |-- background jobs
   |-- integration adapters
   |-- SQLite repository
   `-- local file storage
```

The browser app owns presentation state and client-side STL rendering. The server owns persistence, filesystem access, source synchronization, exports, background jobs, and external integrations.

## Workspaces

### `@print-partner/web`

The React app uses React Router for browser routes and TanStack Query for server state. Three.js renders STL previews in the browser. An IndexedDB cache reduces repeated mesh work.

The main routes are:

| Route | Screen |
|-------|--------|
| `/library` | Shared source library |
| `/builds` | Build list |
| `/sources?profile=<id>` | Sources for one build |
| `/plan?profile=<id>` | Draft and accepted Plan |
| `/progress?profile=<id>` | Checkoff |
| `/export?profile=<id>` | Production workspace for one build |
| `/production` | Cross-build production overview |
| `/printers` | Printer fleet |
| `/settings` | Printer hosts, slicers, library, build tracking, appearance, account, and system settings |

### `@print-partner/server`

The Fastify server provides:

- browser and JSON routes
- SQLite and experimental Postgres adapters
- source sync and archive ingestion
- job execution with WebSocket progress
- STL, 3MF, and bundle exports
- Moonraker, PrusaLink, Bambu, and Spoolman adapters
- streamable HTTP MCP
- authentication and tenant boundaries when multi-user mode is enabled

Long-running work returns a job id. The job runner persists state and publishes progress to connected clients.

### `@print-partner/contracts`

This package defines shared data contracts. Browser code should call the typed endpoint layer instead of duplicating request or response shapes.

### `@print-partner/domain`

This package contains framework-independent rules for manifests, Plan state, quantities, plate packing, and 3MF output. It does not depend on React, Fastify, or a database driver.

## Core model

A **Library Source** points to a Git repository, local directory, or uploaded archive. Syncing creates a source revision and records the STL files and metadata available at that revision.

A **Build** selects one or more sources. Its draft records file choices, quantities, roles, colors, and manifest options. Applying the draft creates the accepted Plan used by Checkoff and Production.

An accepted Plan revision owns:

- required units
- checkoff state
- plate arrangements
- exported artifacts
- printer handoff records

Changing source inputs invalidates dependent draft or accepted state through explicit revision checks. The UI does not infer freshness from timestamps alone.

## Storage

Self-host mode uses SQLite and local files under `PRINT_PARTNER_DATA_DIR`. The Docker image maps this directory to `/data`.

Postgres and S3 adapters exist for multi-user deployment. The Postgres path uses a synchronous compatibility bridge and does not provide the same transaction model as SQLite. Production startup requires `POSTGRES_EXPERIMENTAL=1`. SQLite remains the supported database.

Both database dialects maintain a `schema_version`. Migrations run during startup before the server accepts traffic.

## Source synchronization

Source sync prepares a new revision away from the active path, validates it, then publishes it. Readers continue using the previous revision until the new one is ready. This prevents partial clones or extracted archives from becoming active source data.

Import rules, source naming rules, and manifest metadata determine which files appear in the Library and Build workflow.

## Exports and slicers

Print Partner packs accepted units against enabled printer bed dimensions. It writes 3MF archives with Core and Materials XML and can also create STL bundles. Slicing remains the responsibility of OrcaSlicer, PrusaSlicer, Bambu Studio, or another slicer.

Each accepted Plate revision is immutable. A new arrangement creates a new revision, which keeps downloaded files and printer handoffs tied to the Plan state that produced them.

## Printer integrations

Printer fleet entries store planning geometry. Optional host integrations provide live status and send capabilities.

- Moonraker supports status, upload, and optional start.
- PrusaLink supports status, upload, and optional start.
- Bambu LAN MQTT supports status.
- Bambu Connect provides a file handoff URL.
- Spoolman provides filament inventory and optional usage deduction.

Every outbound printer URL passes the server's outbound URL guard. Secrets are stored separately from public integration configuration and are redacted from API responses and logs.

See [Printer setup](integrations/PRINTER_SETUP.md) and [Spoolman](integrations/SPOOLMAN.md).

## MCP boundary

The server exposes product operations over streamable HTTP MCP at `/api/v1/mcp`. Read operations return current application data. Write operations return a proposal and require `confirm_apply` before mutation.

Remote MCP access requires `PRINT_PARTNER_API_KEY`. The optional stdio transport is intended for an offline copy of the data directory, not a live SQLite volume already owned by the server.

See [MCP setup](assistant-mcp.md).

## Security boundaries

- Validate network, filesystem, archive, and user input at route or adapter boundaries.
- Keep tenant ids on persisted records in multi-user mode.
- Block cloud metadata addresses in outbound URL checks.
- Require explicit credentials for remote API and MCP access.
- Keep the app process non-root after the container entrypoint prepares `/data`.

See [Security](../SECURITY.md) and [Operations](../OPERATIONS.md).
