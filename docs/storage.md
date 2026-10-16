# Storage

Print Partner keeps its SQLite database and local files in one data directory.

## Data directory

| Runtime | Location |
| --- | --- |
| Desktop app | `~/.print-partner` by default |
| Docker image | `/data` inside the container (the Node image today) |
| Node server | `PRINT_PARTNER_DATA_DIR` |

The Rust core uses SQLite only. It does not support Postgres.

## One writer

Only one Print Partner runtime may own a data directory at a time. The Rust core and standalone Rust writer acquire an exclusive OS advisory lock on `<data-dir>/printpartner.lock` with [fs4](https://docs.rs/fs4/1.1.0/fs4/). They take it before database preflight, migrations, or any SQLite open. A second instance refuses with `Data directory already owned; stop the other Print Partner process before starting another instance`.

The runtime holds the lock while it can access storage, including compatibility-child restarts. Graceful shutdown releases it after database closure and child reaping. If writer closure or cleanup cannot be proved, the runtime retains ownership until a successful cleanup retry or process exit. The kernel releases the lock when its last owning descriptor closes, including after a crash or SIGKILL. The lock file remains on disk. Its presence does not mean the directory is owned, and startup does not delete it.

The supervised Node compatibility child inherits the locked descriptor at fd 198. The core sets `PP_STORAGE_CORE_LOCK=1`, so the child validates that descriptor against `printpartner.lock`. After the existing parent setup validates the descriptor and ownership marker, the child opens storage under the core's lock without acquiring its own directory lease. Setting the flag alone does not bypass standalone ownership checks. Standalone Node, including today's Docker image and stdio MCP entry point, keeps its existing directory lease behavior.

Rust already held an OS advisory lock on `.desktop.lock` before GRE-636. This first slice adds `printpartner.lock` before all database opens and passes that descriptor to the child. The `.desktop.lock`, directory lease, and owner markers remain temporarily for coordination with standalone Node and existing cleanup. Their removal is the next GRE-636 slice. Legacy marker failures can still refuse admission even when `printpartner.lock` is available.

Deleting, renaming, moving, or replacing the data directory or either lock file while any instance runs is unsupported. Stop every instance before moving the directory. Advisory locks require cooperating processes and a filesystem that supports them. An older or standalone Node process still relies on the retained directory lease protocol.

## Ownership today

- `pp-storage` owns the SQLite connection, migrations, the bounded settings writer, the read-only pool, the storage lease and safe backups.
- The Node server still runs the application SQL, startup migrations and jobs.
- The desktop rebuild slices move these operations into `pp-storage` behind `desktop_rebuild`. See [Desktop rebuild flag](desktop-rebuild.md).

## To be written

The storage milestone fills in these sections:

- Schema versions and how migrations run on startup.
- Backup, restore and downgrade blocking.
- Durable jobs and recovery after an interrupted external effect. An interrupted printer send is never retried automatically.

[Operations](../OPERATIONS.md) describes backups for the current Node server.
