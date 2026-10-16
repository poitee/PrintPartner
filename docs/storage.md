# Storage

Print Partner keeps its state in one data directory: a SQLite database and local files. This page will describe who owns that directory, how migrations run and how the app recovers after a crash. Most of it is a stub until the storage milestone lands.

## Data directory

| Runtime | Location |
| --- | --- |
| Desktop app | `~/.print-partner` by default |
| Docker image | `/data` inside the container (the Node image today) |
| Node server | `PRINT_PARTNER_DATA_DIR` |

The Rust core uses SQLite only. It does not support Postgres.

## One writer

Only one process may write to a data directory at a time. The target design uses an OS advisory file lock on the data directory (GRE-636). It replaces the directory leases and owner markers that `pp-storage` and the Node server use today. The kernel releases the lock when the process exits or crashes, so a new instance starts without stale-owner cleanup. A second instance that cannot take the lock does not open the data directory. Deleting or moving the data directory while the app runs is not supported.

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
