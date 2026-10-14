# GRE-402 remaining scope

This change admits the Node Source Sync operation before HTTP aliases, MCP `start_sync`, job execution, and watcher timers. It rejects conflicting worker/startup ownership, unknown owners, and an unsupported Rust assignment. It does not finish GRE-402.

Desktop `CoreRuntime` startup persists `source-sync-admission.json` in the storage-lease data directory before bind and before the compatibility process. `Gateway::start` repeats the bundled manifest check in memory and does not choose a second directory. Source Sync execution stays on Node until the Rust executor is integrated.

`ownership::manifest` combines claims from `ownership-manifest.json`, `operations.json`, and the Source Sync record. Each HTTP registry entry claims its route through `owner` and `operation`. Admission accepts only `compat` registry ownership and parses it as Node ownership. Explicit manifest groups take precedence, and HEAD inherits its GET group. A route needs no separate participant entry when the registry already claims it. Every resolved operation still needs an explicit resource state. Other Node participants use the manifest's explicit groups or `node_participants` lists.

The index covers 833 desktop-registered Fastify routes and aliases, 89 assistant tool dispatch cases, 39 confirmed assistant actions (`start_sync` keeps its Source Sync id `mcp.start_sync`), 3 MCP-only tools, 10 job kinds and 9 startup, worker and migration hooks. A double claim, an alias group split across operations, a claim on a refused or unregistered route, an unsupported owner, or an unknown kind fails admission. A lookup for an unclaimed participant fails closed. The census test derives each set from source and fails when the combined index misses a participant or claims one that no longer exists. Desktop startup admits the index only when `desktop_rebuild` is on. Outside `source.sync`, HTTP aliases share registry operation groups. Other Node participants are still each their own operation.

## Reviewed resources

The resource index joins the resolved ownership claims with an exhaustive `Reviewed` or `Unresolved` partition. `resources_for(participant)` returns a shared immutable typed set or an admission error. HTTP aliases and HEAD inherit their operation's state. Unknown participants and unresolved operations never return an empty set. Missing, duplicate, stale, or downgraded states fail admission. Reviewed operations require exact compiled resource sets, including rejection of extra known resources. Shared Node resources are valid. Rust ownership remains unsupported.

The manifest currently resolves 441 operations. Eight are reviewed and 433 remain explicitly unresolved. `ticket_t_7_operation_resources` derives the partition from admitted claims and checks every unresolved omission. It also checks literal resource sets, aliases, malformed declarations, and reviewed-resource mutations.

- `tool.get_plan_decisions` covers `build_profiles` and `plan_decisions`. An explicit plan ID reads the tenant-owned profile identity before the decision trail. Active-plan fallback reads only the decision trail. The tool makes no filesystem calls.
- `tool.get_workflow_help` has an explicitly reviewed empty resource set. It returns the static workflow guide without SQL or filesystem access.
- `source.sync` imports the union of its existing admitted expected resources. Its receipt and evidence level are unchanged.
- `tool.read_source_file` and `tool.search_source_files` cover `projects`, transitive `source_docs`, and `source-workspace`. Existing-source ID and name lookups read both tables. An unknown search ID reads only `projects`.
- `tool.preview_source_naming` covers `projects` and `app_settings`. Source naming reads a project row directly, without the `source_docs` count query used by source summaries. The tool reads global naming settings even when a supplied profile overrides the source profile. It makes no filesystem calls.
- `tool.list_sources` and `tool.list_source_categories` cover `projects`, transitive `source_docs`, and `app_settings`. Category-filtered listing reads `app_settings`; unfiltered listing does not.

`operation-resources.test.ts` invokes the real tools with a migrated SQLite database, repository, and files. Native SQLite verbose callbacks record the supported SELECT shapes. Forwarding filesystem observers record canonicalization, existence, directory traversal, lstat, stat, open, read, and close. Unsupported SQL or filesystem calls fail assertions after the handler returns, even when the handler catches errors. The original three-tool test pins its own tool IDs, resource unions, file contents, document counts, and category results before comparing the manifest. A separate search test pins its operation-wide union and literal search results. It covers ID and name resolution, ID precedence, missing selectors and sources, absent and nonexistent roots, empty queries, nested files, excluded directories, child file and directory symlinks, no matches, default and clamped limits, truncation, and a file as the root. It records full traversal before limiting results and asserts no content reads. Two tenants share the real database, and every observed SELECT must name the active tenant. This does not prove tenant filesystem isolation.

`source-workspace` means the logical source root under the desktop trusted single-user policy, including user-local roots. `read_source_file` tests exercise in-root and escaping symlinks. Its escaping canonicalization probe is denied before open or read. Search skips child symlinks to files and directories inside and outside the root, and excludes `.git`, `node_modules`, and `.docs-text`. Trusted search follows root and ancestor symlinks. The tests demonstrate this behavior and do not claim confinement. Sources created without a local path receive a `repos/<id>` root, whose existence search checks before query validation. A stored null root rejects without filesystem calls. List tools make no filesystem calls under this policy. SQLite database and WAL files implement table storage and are not separate application file families.

The naming test independently pins its two-table union. It checks missing and non-array paths, non-string path filtering, numeric and string source IDs, missing and invalid IDs, source and supplied overrides, invalid supplied regexes, malformed stored source and global settings, and separate tenant settings. Every observed SQL statement must be a supported tenant-scoped SELECT; filesystem calls fail the proof. Literal role and quantity results establish that the real parser ran.

The workflow help test invokes the real dispatcher in two tenant contexts and checks the exact bounded guide with no SQL or filesystem access. An undeclared-read control rejects projects and source_docs reads against its empty declaration. Temporarily adding `listSources()` inside the real tool also fails its zero-SQL assertion; restoring the tool passes the focused suite.

The plan decisions test pins its two-table union through the real dispatcher. It checks numeric and string plan IDs, limit selection, empty plans, missing and invalid IDs, active-plan fallback, and tenant isolation. Every observed statement must be a supported tenant-scoped SELECT, and the observer requires zero filesystem calls. Rust controls retain Node ownership and refuse incompatible schema rollback, missing or duplicate resources, downgrades, and participant regrouping.

These are operation-wide unions across the tested branches, not runtime access enforcement or a complete resource census. The proof does not cover isolated or multi-user filesystem policy, PostgreSQL, every possible input, or future branches. Startup admission remains behind the existing default-off `desktop_rebuild` build and environment gates. No cutover or execution routing changes occur.

## Live-format rollback

A rollback returns an operation from Rust to Node after Rust wrote its resources. `OwnershipIndex::admit_rollback(participant)` admits it only when Node reads every format Rust leaves behind. Code maps each resource to one format: every table to `sqlite-schema`, `source-workspace` to `source-revision-workspace`, and `source-covers` to `source-covers`. The manifest's `live_formats` object declares the newest version Node reads and the version Rust writes for each format. A format is compatible only when a Rust writer exists and its version is at most Node's.

The declared versions are pinned to source. Node `currentSchemaVersion` is 34 and Rust `pp-storage` stamps 35 after its jobs schema. Both sides read and write source snapshot manifest version 1. Rust has no cover writer, so `source-covers` declares `rust_writes: null`. The Source Sync record's `source-revision-workspace-v1` must match the declared workspace version.

Today every reviewed resource-bearing operation refuses rollback on `sqlite-schema`, because the bundled Node refuses a schema newer than 34. `tool.get_workflow_help` admits rollback with an empty set because it touches no resources or live formats. Unresolved operations refuse with their unresolved-resources error, and unknown participants refuse as unclaimed. A missing, extra, duplicate, untyped or zero-version format, or an omitted `rust_writes`, fails admission. `ticket_t_7_live_formats` checks the literal refusals, an admitted rollback when Node reads schema 35, the covers refusal, and every malformed declaration.

This is a gate for a later cutover. Nothing calls it at runtime yet, and no owner changes.

Still open:

- Tables and files for the 433 unresolved operations. The participant census does not prove their resource access. GRE-402 remains open.
- Grouping Node participants across HTTP, tools, jobs, and hooks before any cutover. Today only `source.sync` groups participants across these kinds.
- Startup hooks are found by call-name verbs (`start`, `migrate`, `sweep`, `backfill`, `prepare`, `seed`) in the server entry points. Timers started inside services are not enumerated.
- Making rollback possible. Node must read schema 35, or Rust must stop at 34, and a Rust cover writer must exist before `source.sync` can roll back. Resource formats of the 433 unresolved operations stay unknown until their resources are reviewed.
- Rust Source Sync cutover. Node stays the owner. #168 (`LocalSourceSyncWorker`) is a later base after restack, not this branch.
- Switching every mapped participant together. Disabling Node aliases while the Node watcher still runs is forbidden.
- A Rust failure must produce its own error and reconciliation result. It must not fall back into a Node mutation.
- GRE-400 and GRE-401 stay open. Their merged storage proofs are not application cutover.
- Parent GRE-339 stays open. This unit does not mark GRE-402 Done.
