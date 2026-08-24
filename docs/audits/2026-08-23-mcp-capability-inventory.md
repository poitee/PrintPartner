# MCP capability inventory

Date: 2026-08-23

## Result

Print Partner exposes 44 MCP tools. It exposes no MCP resources or prompts.

The total consists of 41 product tools and 3 session-control tools. The MCP server removes the six browser-only `ui_*` assistant tools before it returns `tools/list`. Both streamable HTTP and stdio use the same tool server.

Primary sources:

- Tool definitions: [`web/apps/server/src/assistant/tools.ts`](../../web/apps/server/src/assistant/tools.ts)
- MCP registration and dispatch: [`web/apps/server/src/mcp/product-mcp.ts`](../../web/apps/server/src/mcp/product-mcp.ts)
- HTTP transport: [`web/apps/server/src/mcp/http-routes.ts`](../../web/apps/server/src/mcp/http-routes.ts)
- Stdio transport: [`web/apps/server/src/mcp/stdio-server.ts`](../../web/apps/server/src/mcp/stdio-server.ts)

## Read tools

| Tool | Required arguments | Optional arguments | Result |
| --- | --- | --- | --- |
| `get_kit_catalog` | None | None | Summarized bases, add-on categories, and stack presets |
| `list_sources` | None | None | Sources visible in the current repository and tenant context |
| `list_plans` | None | None | Builds with IDs, names, part counts, and stale state |
| `get_plan_snapshot` | `plan_id` | None | Layers, kit selections, and inferred stack preset |
| `get_remaining` | `plan_id` | None | Printed units, remaining units, percentage, and archive eligibility |
| `get_plan_review` | `plan_id` | None | Issue, blocker, role, and filament summary |
| `get_workflow_help` | None | None | Truncated Print Partner workflow guide |
| `list_example_builds` | None | `exclude_plan_id` | Other accessible Builds as examples |
| `get_source_docs` | None | `source_id`, `source_name`, `query` | Synced documents, notes, live README, and pending PDF state |
| `search_plan_parts` | `query` | `plan_id`, `limit` | Matching parts and IDs |
| `get_plan_decisions` | None | `plan_id`, `limit` | Recent applied and dismissed decisions |
| `get_build_recipe` | None | `plan_id` | Base, add-ons, refs, selections, and recent decisions |
| `list_plan_snapshots` | None | `plan_id` | Saved configuration snapshots |
| `compare_plans` | `plan_a_id`, `plan_b_id` | None | Differences in layers, refs, selections, and decisions |
| `get_interaction_graph` | `source_name` | None | Attachment, conflict, slot, and part-replacement rules |
| `check_stack_compatibility` | None | `plan_id`, `layers`, `adding` | Conflicts, occupied slots, warnings, and suggested excludes |
| `ingest_guide_url` | `url` | `plan_id` | Untrusted guide text and extracted decisions |
| `web_search` | `query` | `site` | Untrusted public web search results |
| `fetch_web_page` | `url` | None | SSRF-checked page text without storing guide evidence |
| `read_source_file` | `source`, `path` | None | Text from a synced source with traversal and binary checks |
| `ingest_guide_text` | `text` | `plan_id` | Extracted decisions from pasted guide text |
| `inspect_repo_tree` | None | `url`, `source_name`, `ref` | GitHub tree summary or a synced local source summary |
| `detect_build_decisions` | None | `source_name`, `url`, `plan_id`, `user_constraints` | Variant and optional-mod decisions found in a repository |
| `get_farm_status` | None | None | Live printer, job, idle, and filament-swap state |
| `get_print_stats` | None | `hours` | Recent plate outcomes, filament use, printer totals, and accepted Plan progress |

Several tools accept an omitted `plan_id` because the MCP transport can supply `PRINT_PARTNER_MCP_PLAN_ID`. The JSON schema still requires `plan_id` for tools where the handler does not allow that fallback.

## Proposal tools

These tools do not mutate product state when called. They create a pending action in the current MCP session. The client must call `confirm_apply` with the returned action ID.

| Tool | Required arguments | Optional arguments | Proposed change |
| --- | --- | --- | --- |
| `propose_source_mapping` | `source_name`, `category` | `plan_id`, `option_groups`, `rationale` | Categorize a source and optionally merge kit selections |
| `apply_stack_preset` | `plan_id`, `preset_id` | None | Apply a catalog base, add-ons, and selections |
| `set_base` | `plan_id`, `source_name` | `tag`, `branch` | Set the Build base and optional Git ref |
| `set_source_git_ref` | `source_name` | `tag`, `branch`, `plan_id` | Change a source branch or tag |
| `add_addon` | `plan_id`, `source_name` | None | Attach an add-on source |
| `remove_layer` | `plan_id`, `layer_id` | None | Remove a Build layer |
| `update_kit_selections` | `plan_id`, `selections` | None | Merge kit option selections |
| `start_sync` | None | `source_name`, `source_id`, `project_ids`, `plan_id` | Start source synchronization |
| `apply_build_recipe` | `plan_id` | `source_plan_id` | Replay a Build recipe |
| `create_plan_snapshot` | `plan_id` | `name` | Save a configuration snapshot |
| `propose_restore_snapshot` | `plan_id`, `snapshot_id` | None | Restore a saved configuration snapshot |
| `propose_add_source` | `name` | `url`, `source_kind`, `tag`, `branch`, `role`, `local_path`, `plan_id`, `rationale` | Create a GitHub, Printables, MakerWorld, or local source |
| `import_guide_notes` | `source_name`, `body_markdown` | `title`, `plan_id` | Store guide notes on a source |
| `propose_exclude_replaced_parts` | `plan_id`, `excludes` | `rationale` | Merge replacement exclusions into the kit manifest |
| `duplicate_plan` | `plan_id`, `name` | `clear_checkoff`, `rationale` | Copy a Build |
| `archive_plan` | `plan_id` | `rationale` | Archive a completed Build |

`source_kind` for `propose_add_source` is limited to `github`, `printables`, `makerworld`, or `local`.

## Session-control tools

| Tool | Required arguments | Optional arguments | Behavior |
| --- | --- | --- | --- |
| `list_pending_actions` | None | None | Lists proposals in the current MCP session |
| `confirm_apply` | `action_id` | `suggested_excludes` | Reserves and applies one proposal |
| `dismiss_proposed_action` | `action_id` | None | Removes one proposal without applying it |

Pending actions do not survive a new MCP session. HTTP sessions expire after 30 minutes idle or 8 hours total. The process accepts at most 64 concurrent HTTP MCP sessions.

## Transports and access control

The HTTP endpoint is `/api/v1/mcp` and supports `POST`, `GET`, and `DELETE`. A configured key is always required. The endpoint accepts either `Authorization: Bearer <key>` or `x-print-partner-api-key`. If no key exists, the server exposes MCP only when the configured bind host is loopback. A non-loopback bind without a key returns 503.

HTTP pending actions belong to one MCP session. Request authentication sets the repository tenant context. Confirmed jobs also receive the tenant ID captured when the session starts.

The stdio server supports self-host mode only. It opens the default repository directly, uses one process-local pending-action map, and has no HTTP authentication or request tenant.

## Verification performed

The focused server suite passed 48 tests across 6 files:

- product tool listing and filtering;
- HTTP authentication and initialization;
- session limits, expiry, and cleanup;
- concurrent confirmation, retry, and success behavior;
- live farm integration wiring;
- the main assistant tool-handler suite.

An in-memory MCP client then performed `tools/list` and called all 44 returned tools against a temporary repository. Every registered name reached a handler. Valid read calls returned data. Calls without required values returned structured validation errors. Proposal calls created session-local actions.

A second in-memory flow verified:

1. `start_sync` created a proposal.
2. `list_pending_actions` returned it.
3. `dismiss_proposed_action` removed it.
4. `duplicate_plan` created a proposal.
5. `confirm_apply` invoked the duplicate operation.
6. `list_plans` observed the resulting copy.

## Verified problems and coverage gaps

### Failed confirmation can leave a partial mutation

The duplicate flow returned `{ "ok": false, "detail": "Failed to publish duplicated Plan" }`, but `list_plans` already contained the new copy. `duplicateProfile` inserts the new profile and layers before it attempts to publish the copied Plan. A publication failure throws without removing those inserts.

This is dangerous over MCP because `confirm_apply` restores a failed action to the pending map. A client retry can create another partial copy. The relevant code is `duplicateProfile` in [`web/apps/server/src/db/repository.ts`](../../web/apps/server/src/db/repository.ts) and the `duplicate_plan` apply branch in [`web/apps/server/src/assistant/tools.ts`](../../web/apps/server/src/assistant/tools.ts).

### Validation failures usually do not set MCP `isError`

Most product tools return JSON such as `{ "error": "query required" }` as successful MCP tool results. The MCP adapter sets `isError` only when the handler throws or for selected meta-tool failures. Clients must parse product JSON to distinguish many failures from success.

### Protocol tests are not exhaustive

No test locks down the exact 44-tool list, descriptions, or JSON schemas. Protocol-level successful-call coverage exists for confirmation and farm/status tools, while most behavior tests call `invokeAssistantTool` below the MCP adapter.

The test tree has no direct name reference for these tools:

- `get_workflow_help`
- `list_example_builds`
- `propose_source_mapping`
- `remove_layer`
- `get_plan_decisions`
- `list_plan_snapshots`
- `create_plan_snapshot`
- `propose_restore_snapshot`
- `compare_plans`
- `get_interaction_graph`
- `import_guide_notes`
- `propose_exclude_replaced_parts`
- `list_pending_actions`
- `dismiss_proposed_action`

The absence of a direct test reference is a coverage gap, not proof that a tool fails.

### No resources or prompts

The server declares only the MCP `tools` capability. It registers no resource or prompt handlers.
