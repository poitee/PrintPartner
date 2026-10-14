# GRE-402 remaining scope

This change admits the Node Source Sync operation before HTTP aliases, MCP `start_sync`, job execution, and watcher timers. It rejects conflicting worker/startup ownership, unknown owners, and an unsupported Rust assignment. It does not finish GRE-402.

Desktop `CoreRuntime` startup persists `source-sync-admission.json` in the storage-lease data directory before bind and before the compatibility process. `Gateway::start` repeats the bundled manifest check in memory and does not choose a second directory. Source Sync execution stays on Node until the Rust executor is integrated.

`ownership::manifest` combines claims from `ownership-manifest.json`, `operations.json`, and the Source Sync record. Each HTTP registry entry claims its route through `owner` and `operation`. Admission accepts only `compat` registry ownership and parses it as Node ownership. Explicit manifest groups take precedence, and HEAD inherits its GET group. A route needs no separate manifest entry when the registry already claims it. Other Node participants use the manifest's explicit groups or `node_participants` lists.

The index covers 824 desktop-registered Fastify routes and aliases, 89 assistant tool dispatch cases, 39 confirmed assistant actions (`start_sync` keeps its Source Sync id `mcp.start_sync`), 3 MCP-only tools, 10 job kinds and 9 startup, worker and migration hooks. A double claim, an alias group split across operations, a claim on a refused or unregistered route, an unsupported owner, or an unknown kind fails admission. A lookup for an unclaimed participant fails closed. The census test derives each set from source and fails when the combined index misses a participant or claims one that no longer exists. Desktop startup admits the index only when `desktop_rebuild` is on. Outside `source.sync`, HTTP aliases share registry operation groups. Other Node participants are still each their own operation.

Still open:

- Tables and files per operation. The census does not track mutated tables or files outside `source.sync`.
- Grouping Node participants across HTTP, tools, jobs, and hooks before any cutover. Today only `source.sync` groups participants across these kinds.
- Startup hooks are found by call-name verbs (`start`, `migrate`, `sweep`, `backfill`, `prepare`, `seed`) in the server entry points. Timers started inside services are not enumerated.
- Compatible rollback proof for every live format. This unit checks the Source Sync format declaration only.
- Rust Source Sync cutover. Node stays the owner. #168 (`LocalSourceSyncWorker`) is a later base after restack, not this branch.
- Switching every mapped participant together. Disabling Node aliases while the Node watcher still runs is forbidden.
- A Rust failure must produce its own error and reconciliation result. It must not fall back into a Node mutation.
- GRE-400 and GRE-401 stay open. Their merged storage proofs are not application cutover.
- Parent GRE-339 stays open. This unit does not mark GRE-402 Done.
