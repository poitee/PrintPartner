# Architecture

Print Partner plans and tracks layered STL kit builds. The project is moving its backend from Node to one Rust core. This page describes the target, the current state and the Rust crates.

## Target

One Rust core runs in two products:

- **Desktop app.** `pp-desktop` opens the web UI in a native window. Its "Share on network" setting serves the same UI to phones, tablets and other computers on the local network. Sharing is off by default and requires login or device pairing. See [Desktop app](desktop.md) and [Network sharing](network-sharing.md).
- **Docker image.** `pp-server` runs the core headless for one user. Docker is the only headless mode. There is no launchd, systemd or Windows Service mode. See [Docker image](docker.md).

The React web UI stays. The Rust core serves it to the desktop window and to browsers.

Only one process writes to a data directory at a time. An OS advisory file lock will enforce this (GRE-636). See [Storage](storage.md).

Platforms ship in this order: macOS first, then Windows and Linux before 1.0. CI will build and test the Rust workspace on all three (GRE-632).

These are out of scope:

- Multi-user accounts, a hosted SaaS mode and Postgres.
- West3D order and farm features. They come after the Rust core reaches parity with the Node server.

## Current state

The Rust gateway runs on loopback in front of the existing Node server. Node runs as a supervised child process and listens on a private Unix socket.

```text
Desktop window or browser
   |
   | HTTP and WebSocket (loopback)
   v
pp-gateway (Rust)
   |-- web UI assets
   |-- session and route admission
   `-- proxy
         |
         | private Unix socket
         v
      Node compatibility server (web/apps/server)
         `-- SQLite and files in the data directory
```

Rust owns the data directory lock, the gateway and the Node process lifetime. Node still owns the domain operations, the SQL, migrations and jobs. The desktop rebuild slices move these operations into Rust behind the default-off `desktop_rebuild` feature. See [Desktop rebuild flag](desktop-rebuild.md).

The Node server also has multi-user, hosted planning and experimental Postgres modes. The Rust core does not carry them over. When Rust reaches parity, Node leaves the shipped artifacts. npm and Vite stay as the build tools for the React UI.

## Crate map

The workspace is `rust/Cargo.toml`. A dependency marked "flagged" compiles only with `desktop_rebuild`.

| Crate | Role | Depends on |
| --- | --- | --- |
| `pp-domain` | Pure domain values and rules. No Tokio, SQLite, HTTP or Tauri. | none |
| `pp-api-types` | Wire DTOs, validation and parsers, such as autosave and printer status. | `pp-domain` |
| `pp-contracts` | Contract facade over `pp-api-types` for parity tooling and external consumers. | `pp-api-types` |
| `pp-net` | Checked outbound connections and target canonicalization. | none |
| `pp-drivers` | Printer adapters. Moonraker status today, plus unrouted Moonraker driver reads. | `pp-net`, `pp-api-types` |
| `pp-services` | Native Orca and Bambu slicer discovery. | none |
| `pp-storage` | SQLite owner: migrations, settings, read model, jobs, catalog, storage lease and backups. | `pp-domain`, `pp-contracts` (both flagged) |
| `pp-source` | Immutable Source snapshots and bounded ZIP extraction. | none |
| `pp-api` | Rust HTTP API. Holds the auth module today. | `pp-storage` |
| `pp-gateway` | Loopback listener, sessions, route ownership, web UI assets and the proxy to Node. | `pp-compat`, `pp-drivers`, `pp-net` |
| `pp-compat` | Supervises the Node compatibility server and its private socket. Goes away with Node. | none |
| `pp-core` | Composition root for the storage lease, gateway and supervisor lifetimes. | `pp-gateway`, `pp-compat`, `pp-storage`, `pp-source` (flagged), `pp-net` (flagged) |
| `pp-desktop` | Tauri window and tray around `pp-core`. | `pp-core` |
| `pp-server` | Headless launcher around `pp-core`. | `pp-core` |

`rust/scripts/check-boundaries.py` rejects any crate dependency that its allow list does not name. [ADR 0007](adr/0007-rust-crate-layout.md) records the allowed edges and the planned ones.

## Web UI

`web/` is an npm workspace with four packages:

| Package | Role |
| --- | --- |
| `@print-partner/web` | React and Vite UI. Renders STL previews in the browser with Three.js. |
| `@print-partner/server` | Fastify API and static file server. The Rust core replaces it. |
| `@print-partner/contracts` | Shared request and response types. |
| `@print-partner/domain` | Framework-independent rules for manifests, Plan state, quantities, plate packing and 3MF output. |

The UI owns presentation state. The server owns persistence, filesystem access, source sync, exports, jobs and integrations. [Domain](domain/README.md) describes the core model and each product area.

## Security boundaries

- Validate network, filesystem, archive and user input at route or adapter boundaries.
- Block cloud metadata addresses in outbound URL checks.
- Require credentials for remote API and MCP access.
- Keep secrets out of API responses and logs.
- Run the app process as a non-root user in the container.

See [Security](../SECURITY.md) and [Operations](../OPERATIONS.md).
