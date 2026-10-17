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

The supervised Node compatibility child inherits the locked descriptor at fd 198. The core sets `PP_STORAGE_CORE_LOCK=1`. Private parent setup validates the inherited descriptor against `printpartner.lock` and verifies the parent PID and canonical data directory. The child then opens only that directory under the core's lock. Setting the environment flag alone does not bypass standalone ownership checks. Supervised descendants that access storage retain the descriptor. Detached Bambu Connect launchers replace fd 198 with `/dev/null` before execution, so those external applications cannot retain the lock after a core crash.

Until standalone Node retires, Rust reserves the `.desktop-lease` name with a regular file while holding the advisory lock. Standalone Node publishes a directory at that same name. Neither publication can replace the other file type, so Rust and standalone Node exclude each other before opening the database. Rust refuses an existing directory without reading its contents, checking PIDs, or recovering stale leases. Standalone Node, including today's Docker image, keeps its existing directory lease behavior.

A Rust crash can leave the regular `.desktop-lease` file. The next Rust instance reuses it after acquiring `printpartner.lock` and removes it on orderly shutdown before releasing the advisory lock. Cleanup compares the current entry with the acquired reservation by device and inode through the held directory descriptor. A replacement entry is left untouched, and cleanup retains the advisory lock until the acquired reservation is restored or the entry is removed. Standalone Node conservatively refuses that file until a Rust instance completes shutdown. A lease directory left by standalone Node also blocks Rust. Stop every instance before manually clearing a legacy Node lease.

Rust does not create or inspect owner markers, marker directories, or `.desktop.lock`. Legacy artifacts have no authority over Rust admission beyond the `.desktop-lease` compatibility name. Pre-GRE-636 Rust executables do not cooperate with this locking model.

Deleting, renaming, moving, or replacing the data directory, `printpartner.lock`, or `.desktop-lease` while any instance runs is unsupported. Stop every instance before moving the directory. Advisory locks require cooperating processes and a filesystem that supports them.

Storage admission and preflight I/O failures identify the filesystem operation and entry. The subprocess ownership proofs preserve the complete error chain in refusal events and print the debug error to stderr.

The shutdown receipt's legacy `marker_removed` field now reports removal of the `.desktop-lease` compatibility file. `CoreRuntime::runtime_dir()` exposes the private socket directory for lifecycle inspection without an owner marker. The existing launcher test receipt also carries `child_pid` and `runtime_dir`. These fields replace lifecycle fixtures' marker reads and are emitted only with `--test-credential-file`.

The compatibility backend serves only on that private socket. `rust/tests/built_backend_listeners.py` runs the built backend in desktop mode on Linux and macOS CI. It checks that the socket has mode `0600` inside a `0700` directory. It reads the kernel's system-wide table of listening TCP and bound, unconnected UDP endpoints (`/proc/net/{tcp,tcp6,udp,udp6}` on Linux, `netstat -an -p tcp` and `-p udp` on macOS) before launch. It then compares the table about every 100 ms from launch through a 4-second window after readiness and through shutdown. Any new endpoint fails the proof, whichever process opened it. The kernel lists sockets without inspecting their owners, so a process that lsof cannot inspect still fails it. lsof only attributes each new endpoint to a process; the failure prints each owner's full command line and whether it is in the backend's process group, or `unattributed`. A missing or unparseable table also fails the proof. Before the run, a self-test checks both parsers against fixed `/proc/net` and macOS `netstat` samples. The backend must stay alive through the window and then stop on stdin EOF. Four negative controls must fail the same check: a child listener, a detached grandchild listener, a backend listener opened 1 second after readiness and, on Linux only, a detached listener that disables its dumpability so lsof cannot see it. Every process that inherited the run's environment token is killed after shutdown. On a shared machine, other users' listeners also fail the proof; CI runners are dedicated, so CI is the gate.

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
