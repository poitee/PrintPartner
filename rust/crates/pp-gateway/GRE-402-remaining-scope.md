# GRE-402 remaining scope

This change admits the Node Source Sync operation before HTTP aliases, MCP `start_sync`, job execution, and watcher timers. It rejects conflicting worker/startup ownership, unknown owners, and an unsupported Rust assignment. It does not finish GRE-402.

Desktop `CoreRuntime` startup persists `source-sync-admission.json` in the storage-lease data directory before bind and before the compatibility process. `Gateway::start` repeats the bundled manifest check in memory and does not choose a second directory. Source Sync execution stays on Node until the Rust executor is integrated.

`ownership::manifest` combines claims from `ownership-manifest.json`, `operations.json`, and the Source Sync record. Each HTTP registry entry claims its route through `owner` and `operation`. Admission accepts only `compat` registry ownership and parses it as Node ownership. Explicit manifest groups take precedence, and HEAD inherits its GET group. A route needs no separate participant entry when the registry already claims it. Every resolved operation still needs an explicit resource state. Other Node participants use the manifest's explicit groups or `node_participants` lists.

The index covers 824 desktop-registered Fastify routes and aliases, 89 assistant tool dispatch cases, 39 confirmed assistant actions (`start_sync` keeps its Source Sync id `mcp.start_sync`), 3 MCP-only tools, 10 job kinds and 9 startup, worker and migration hooks. A double claim, an alias group split across operations, a claim on a refused or unregistered route, an unsupported owner, or an unknown kind fails admission. A lookup for an unclaimed participant fails closed. The census test derives each set from source and fails when the combined index misses a participant or claims one that no longer exists. Desktop startup admits the index only when `desktop_rebuild` is on. Outside `source.sync`, HTTP aliases share registry operation groups. Other Node participants are still each their own operation.

## Reviewed resources

The resource index joins the resolved ownership claims with an exhaustive `Reviewed` or `Unresolved` partition. `resources_for(participant)` returns a shared immutable typed set or an admission error. HTTP aliases and HEAD inherit their operation's state. Unknown participants and unresolved operations never return an empty set. Missing, duplicate, stale, or downgraded states fail admission. Reviewed operations require exact compiled resource sets, including rejection of extra known resources. Shared Node resources are valid. Rust ownership remains unsupported.

The manifest currently resolves 437 operations. Four are reviewed and 433 remain explicitly unresolved. `ticket_t_7_operation_resources` derives the partition from admitted claims and checks every unresolved omission. It also checks literal resource sets, aliases, malformed declarations, and reviewed-resource mutations.

- `source.sync` imports the union of its existing admitted expected resources. Its receipt and evidence level are unchanged.
- `tool.read_source_file` covers `projects`, transitive `source_docs`, and `source-workspace`.
- `tool.list_sources` and `tool.list_source_categories` cover `projects`, transitive `source_docs`, and `app_settings`. Category-filtered listing reads `app_settings`; unfiltered listing does not.

`operation-resources.test.ts` invokes the real tools with a migrated SQLite database, repository, and files. Native SQLite verbose callbacks record the supported SELECT shapes. Forwarding filesystem observers record canonicalization, existence, stat, open, read, and close. Unsupported SQL or filesystem calls fail assertions after the handler returns, even when the handler catches errors. Tests independently pin the three tool IDs, resource unions, file contents, document counts, and category results before comparing the manifest.

`source-workspace` means the logical source root under the desktop trusted single-user policy, including user-local roots. Tests exercise in-root and escaping symlinks. An escaping canonicalization probe is denied before open/read; it does not admit access to arbitrary files. List tools make no filesystem calls under this policy. SQLite database and WAL files implement table storage and are not separate application file families.

These are operation-wide unions across the tested branches, not runtime access enforcement or a complete resource census. The proof does not cover isolated or multi-user filesystem policy, PostgreSQL, every possible input, or future branches. Startup admission remains behind the existing default-off `desktop_rebuild` build and environment gates. No cutover or execution routing changes occur.

Still open:

- Tables and files for the 433 unresolved operations. The participant census does not prove their resource access. GRE-402 remains open.
- Grouping Node participants across HTTP, tools, jobs, and hooks before any cutover. Today only `source.sync` groups participants across these kinds.
- Startup hooks are found by call-name verbs (`start`, `migrate`, `sweep`, `backfill`, `prepare`, `seed`) in the server entry points. Timers started inside services are not enumerated.
- Compatible rollback proof for every live format. This unit checks the Source Sync format declaration only.
- Rust Source Sync cutover. Node stays the owner. #168 (`LocalSourceSyncWorker`) is a later base after restack, not this branch.
- Switching every mapped participant together. Disabling Node aliases while the Node watcher still runs is forbidden.
- A Rust failure must produce its own error and reconciliation result. It must not fall back into a Node mutation.
- GRE-400 and GRE-401 stay open. Their merged storage proofs are not application cutover.
- Parent GRE-339 stays open. This unit does not mark GRE-402 Done.
