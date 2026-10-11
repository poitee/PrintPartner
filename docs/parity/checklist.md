# Print Partner Desktop parity checklist (GRE-578)

Tracks every user-facing UI page and every MCP tool that the Rust desktop core
must reach parity with. One row per item. Docs only; no code changes.

## Sources and limits

- **GRE-542 MCP inventory golden:** not on `main` at `0f4c9ef`, so it was not used.
- **Conversion plan section 2:** not in this repository, so it was not used.
- **Linear (GRE-578 and related tickets):** the Linear connector is not
  authorized in this session, so the Linear ticket and milestone columns are
  `TBD`. Fill them from Linear before this checklist gates work.
- The rows below come from the code on `main`:
  - UI pages: the page components in `web/apps/web/src/pages/` and their routes
    in `web/apps/web/src/AuthenticatedApp.tsx`.
  - MCP tools: `ASSISTANT_TOOL_SPECS` in
    `web/apps/server/src/assistant/tool-specs.ts`, minus the SPA-only `ui_*`
    tools, plus the three proposal tools in `web/apps/server/src/mcp/product-mcp.ts`.
- Owner crates are assigned from the crate names in `rust/crates/`. They are a
  proposal, not an agreed split.

## Column meanings

- **Owner crate:** the `rust/crates/pp-*` crate that would own the item.
- **Linear ticket / Milestone:** `TBD` until read from Linear.
- **Status:**
  - `missing`: no Rust implementation on `main`. Every route in
    `rust/crates/pp-gateway/operations.json` is `owner: compat` (767 of 767),
    which means Node still serves all of them.
  - `inflight`: work in progress on an open PR or branch. Not determined here.
  - `on main`: implemented in Rust on `main`. No row qualifies yet.
- **Golden/fixture:** link to a golden or fixture for the item, or `—` if none exists.

## UI pages (15 rows)

Redirect-only routes (`/build`, `/plans`, `/parts`, `/review`, `/checkoff`,
`/plate`, `/print`, `/plans/:planId/studio`) are not pages and have no rows.
They forward to the pages above.

| Page | Route | Owner crate | Linear ticket | Milestone | Status | Golden/fixture |
|---|---|---|---|---|---|---|
| `LoginPage` | `/login, /setup` | pp-server | TBD | TBD | missing | — |
| `ForgotPasswordPage` | `/forgot-password` | pp-server | TBD | TBD | missing | — |
| `ResetPasswordPage` | `/reset-password` | pp-server | TBD | TBD | missing | — |
| `SourcesPage` | `/library` | pp-source | TBD | TBD | missing | — |
| `BuildPage` | `/sources` | pp-source | TBD | TBD | missing | — |
| `PlansPage` | `/builds` | pp-domain | TBD | TBD | missing | — |
| `PartsPage` | `/plan` | pp-domain | TBD | TBD | missing | — |
| `CheckoffPage` | `/progress` | pp-domain | TBD | TBD | missing | — |
| `GlobalProductionPage` | `/production` | pp-services | TBD | TBD | missing | — |
| `ExportPage` | `/export` | pp-services | TBD | TBD | missing | — |
| `BoardPage` | `/board, /board/:postId` | pp-services | TBD | TBD | missing | — |
| `PrintersPage` | `/printers` | pp-drivers | TBD | TBD | missing | — |
| `SettingsPage` | `/settings` | pp-server | TBD | TBD | missing | — |
| `HelpPage` | `/help` | pp-server | TBD | TBD | missing | — |
| `NotFoundPage` | `* (fallback)` | pp-desktop | TBD | TBD | missing | — |

## MCP tools (85 rows)

The 82 product tools from `ASSISTANT_TOOL_SPECS` (with `ui_*` excluded) and the
three proposal tools (`list_pending_actions`, `confirm_apply`,
`dismiss_proposed_action`). The `plan_build` prompt is not a tool and has no row.
`docs/assistant-mcp.md` describes the MCP surface.

| Tool | Owner crate | Linear ticket | Milestone | Status | Golden/fixture |
|---|---|---|---|---|---|
| `analyze_build_request` | pp-domain | TBD | TBD | missing | — |
| `get_build_workflow` | pp-domain | TBD | TBD | missing | — |
| `get_build_planning_state` | pp-domain | TBD | TBD | missing | — |
| `suggest_source_contributions` | pp-source | TBD | TBD | missing | — |
| `list_build_differences` | pp-domain | TBD | TBD | missing | — |
| `get_plan_draft` | pp-domain | TBD | TBD | missing | — |
| `get_plan_option_groups` | pp-domain | TBD | TBD | missing | — |
| `search_source_files` | pp-source | TBD | TBD | missing | — |
| `get_source_inventory` | pp-source | TBD | TBD | missing | — |
| `get_job_status` | pp-services | TBD | TBD | missing | — |
| `compare_source_revisions` | pp-source | TBD | TBD | missing | — |
| `preview_source_naming` | pp-source | TBD | TBD | missing | — |
| `audit_source_provenance` | pp-source | TBD | TBD | missing | — |
| `analyze_stl_mesh` | pp-server | TBD | TBD | missing | — |
| `audit_build_coverage` | pp-domain | TBD | TBD | missing | — |
| `check_hardware_interfaces` | pp-drivers | TBD | TBD | missing | — |
| `propose_add_build_checklist_items` | pp-domain | TBD | TBD | missing | — |
| `propose_add_custom_filament` | pp-domain | TBD | TBD | missing | — |
| `propose_update_source_naming` | pp-source | TBD | TBD | missing | — |
| `propose_create_build` | pp-domain | TBD | TBD | missing | — |
| `propose_update_build_brief` | pp-domain | TBD | TBD | missing | — |
| `propose_resolve_build_differences` | pp-domain | TBD | TBD | missing | — |
| `propose_assign_role_filament` | pp-domain | TBD | TBD | missing | — |
| `propose_import_build_inputs` | pp-domain | TBD | TBD | missing | — |
| `propose_set_build_source_roles` | pp-domain | TBD | TBD | missing | — |
| `propose_update_source` | pp-source | TBD | TBD | missing | — |
| `propose_import_source_files` | pp-source | TBD | TBD | missing | — |
| `propose_edit_plan_draft_parts` | pp-domain | TBD | TBD | missing | — |
| `propose_rebuild_plan` | pp-domain | TBD | TBD | missing | — |
| `propose_apply_plan_draft` | pp-domain | TBD | TBD | missing | — |
| `find_filament_matches` | pp-domain | TBD | TBD | missing | — |
| `get_kit_catalog` | pp-domain | TBD | TBD | missing | [golden-eval](../../web/apps/server/src/assistant/golden-eval.fixtures.ts) |
| `list_sources` | pp-source | TBD | TBD | missing | — |
| `list_source_categories` | pp-source | TBD | TBD | missing | — |
| `propose_set_source_category` | pp-source | TBD | TBD | missing | — |
| `propose_create_source_category` | pp-source | TBD | TBD | missing | — |
| `propose_rename_source_category` | pp-source | TBD | TBD | missing | — |
| `propose_delete_source_category` | pp-source | TBD | TBD | missing | — |
| `list_plans` | pp-domain | TBD | TBD | missing | — |
| `get_plan_snapshot` | pp-domain | TBD | TBD | missing | — |
| `get_remaining` | pp-domain | TBD | TBD | missing | — |
| `get_plan_checkoff` | pp-domain | TBD | TBD | missing | — |
| `get_printer_checkoff` | pp-drivers | TBD | TBD | missing | — |
| `propose_set_plan_progress` | pp-domain | TBD | TBD | missing | — |
| `propose_set_plan_assembly` | pp-domain | TBD | TBD | missing | — |
| `propose_verify_printer_checkoff` | pp-drivers | TBD | TBD | missing | — |
| `get_plan_review` | pp-domain | TBD | TBD | missing | — |
| `get_workflow_help` | pp-server | TBD | TBD | missing | — |
| `list_example_builds` | pp-domain | TBD | TBD | missing | [golden-eval](../../web/apps/server/src/assistant/golden-eval.fixtures.ts) |
| `get_source_docs` | pp-source | TBD | TBD | missing | — |
| `propose_source_mapping` | pp-source | TBD | TBD | missing | — |
| `apply_stack_preset` | pp-domain | TBD | TBD | missing | [golden-eval](../../web/apps/server/src/assistant/golden-eval.fixtures.ts) |
| `set_base` | pp-domain | TBD | TBD | missing | [golden-eval](../../web/apps/server/src/assistant/golden-eval.fixtures.ts) |
| `set_source_git_ref` | pp-source | TBD | TBD | missing | — |
| `add_addon` | pp-domain | TBD | TBD | missing | — |
| `remove_layer` | pp-domain | TBD | TBD | missing | — |
| `update_kit_selections` | pp-domain | TBD | TBD | missing | — |
| `start_sync` | pp-services | TBD | TBD | missing | — |
| `search_plan_parts` | pp-domain | TBD | TBD | missing | — |
| `get_plan_decisions` | pp-domain | TBD | TBD | missing | — |
| `get_build_recipe` | pp-domain | TBD | TBD | missing | — |
| `apply_build_recipe` | pp-domain | TBD | TBD | missing | — |
| `list_plan_snapshots` | pp-domain | TBD | TBD | missing | — |
| `create_plan_snapshot` | pp-domain | TBD | TBD | missing | — |
| `propose_restore_snapshot` | pp-domain | TBD | TBD | missing | — |
| `compare_plans` | pp-domain | TBD | TBD | missing | — |
| `get_interaction_graph` | pp-domain | TBD | TBD | missing | — |
| `check_stack_compatibility` | pp-domain | TBD | TBD | missing | — |
| `ingest_guide_url` | pp-net | TBD | TBD | missing | — |
| `web_search` | pp-net | TBD | TBD | missing | — |
| `fetch_web_page` | pp-net | TBD | TBD | missing | — |
| `read_source_file` | pp-source | TBD | TBD | missing | — |
| `ingest_guide_text` | pp-net | TBD | TBD | missing | — |
| `inspect_repo_tree` | pp-source | TBD | TBD | missing | — |
| `detect_build_decisions` | pp-services | TBD | TBD | missing | — |
| `propose_add_source` | pp-services | TBD | TBD | missing | — |
| `import_guide_notes` | pp-services | TBD | TBD | missing | — |
| `propose_exclude_replaced_parts` | pp-services | TBD | TBD | missing | — |
| `duplicate_plan` | pp-services | TBD | TBD | missing | — |
| `archive_plan` | pp-services | TBD | TBD | missing | — |
| `get_farm_status` | pp-services | TBD | TBD | missing | — |
| `get_print_stats` | pp-services | TBD | TBD | missing | — |
| `list_pending_actions` | pp-server | TBD | TBD | missing | — |
| `confirm_apply` | pp-server | TBD | TBD | missing | — |
| `dismiss_proposed_action` | pp-server | TBD | TBD | missing | — |

## Counts

| Section | Rows |
|---|---|
| UI pages | 15 |
| MCP tools | 85 |
| **Total** | **100** |

All 100 rows are `missing`. Four tool rows link a golden fixture
(`golden-eval.fixtures.ts`).
