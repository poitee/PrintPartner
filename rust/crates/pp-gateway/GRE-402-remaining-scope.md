# GRE-402 remaining scope

This change admits the Node Source Sync operation before HTTP aliases, MCP `start_sync`, job execution, and watcher timers. It rejects conflicting worker/startup ownership, unknown owners, and an unsupported Rust assignment. It does not finish GRE-402.

Desktop `CoreRuntime` startup persists `source-sync-admission.json` in the storage-lease data directory before bind and before the compatibility process. `Gateway::start` repeats the bundled manifest check in memory and does not choose a second directory. Source Sync execution stays on Node until the Rust executor is integrated.

Still open:

- The all-operation ownership manifest. Only `source.sync` is admitted here.
- Compatible rollback proof for every live format. This unit checks the Source Sync format declaration only.
- Rust Source Sync cutover. Node stays the owner. #168 (`LocalSourceSyncWorker`) is a later base after restack, not this branch.
- Switching every mapped participant together. Disabling Node aliases while the Node watcher still runs is forbidden.
- A Rust failure must produce its own error and reconciliation result. It must not fall back into a Node mutation.
- GRE-400 and GRE-401 stay open. Their merged storage proofs are not application cutover.
- Parent GRE-339 stays open. This unit does not mark GRE-402 Done.
