/** Shared workflow markdown shown in Help and injected into the AI advisor context. */
export const WORKFLOW_GUIDE = `# Print Partner workflow

Print Partner organizes each Build as **Sources → Plan → (Production ↔ Checkoff)**. Sources and Plan prepare reviewed production intent. Production and Checkoff form a loop that repeats until every required unit is verified. Global navigation is Builds, All Production, Printers, and Settings.

## Managing Builds

- **Builds.** Search, filter, and open a Build.
- **Build picker.** Switch the active Build from the sidebar. Archived Builds stay listed as templates.
- **New Build.** Create one under the picker or from the primary action on Builds.
- **Build actions.** Rename, Duplicate, Delete, and eligible Archive actions are in the overflow menu.

The active Build is shared across Sources, Plan, Production, and Checkoff. The sidebar reports each area's current status and the next safe action.

## Prepare

### Source library

Register GitHub repositories, local folders, or zip archives. Set categories and import rules, then sync the Source. The library shows update availability and supports STL search across synced Sources.

### Sources

Attach a structural base and any optional overlays or add-ons to the active Build. Pick included STL files, confirm roles and filament colors, and review Source revisions. **Build Working Plan** creates or updates the editable proposal. It does not change the Accepted Plan or Checkoff.

### Plan

Review the Working Plan's quantities, inclusion choices, warnings, and required-unit reconciliation. Resolve every blocking issue, then choose **Accept Working Plan**. Acceptance creates a new Accepted Plan revision. Only an Accepted Plan authorizes new Production work; existing Production and Checkoff records remain tied to the revision that created them.

## Make

### Production

Choose required units from the Accepted Plan, allocate printers, prepare editable plates, export to a slicer, and send printer jobs. Production remains active while jobs are queued, sending, or printing. Having Parts in a Plan does not make Production complete.

### Checkoff

Verify completed print results before they change progress. Confirm successful units, record rejected results, and keep remaining units visible. Failed or remaining units return to Production for another run. Global All Production aggregates active jobs and work awaiting verification across Builds.

## Tips

- **⌘K / Ctrl+K.** Open the command palette for navigation, sync, and export actions.
- **Theme.** Choose light, dark, or system. The sidebar can collapse to an icon rail.
- **Share Build.** Export Plan configuration as a \`.print-partner-kit\` archive. STL files are not included.
- **Spoolman.** Connect it in Settings → Integrations for live filament inventory and spool weights.
- **API.** OpenAPI is available at \`/api/v1/openapi.json\`. Self-hosted installations can require an API key.
`;
