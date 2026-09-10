import {
  externalApiAccessEnabled,
  type ExternalAccessMode,
} from "@print-partner/contracts";

const CORE_WORKFLOW_GUIDE = `# Print Partner workflow

Print Partner organizes each Build as **Sources → Plan → (Production ↔ Checkoff)**. Sources and Plan define what to make. Production and Checkoff repeat until every required unit is verified. Use Library to manage reusable projects across Builds.

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

Attach projects from Library to the active Build. Choose the base project and any optional add-ons, then select the files to include. Syncing Library does not by itself change an existing Build's saved Plan.

### Plan

Choose quantities, included parts, roles, and filament colors. Changes save automatically. Wait for **Saved** before preparing new Production work. If the page shows **Not saved**, resolve the displayed error and retry. There is no separate acceptance or publishing step. Existing Production and Checkoff records keep the Plan revision they were created with.

## Make

### Production

Choose required units from the saved Plan, assign printers, prepare plates, export to a slicer, and send printer jobs. Having parts in a Plan does not mean they have been printed.

### Checkoff

Monitor linked printers, browse their files, or upload print files from an unmonitored printer. Assign results to the correct Build, then verify successful units before they count toward progress. Record rejected units and return remaining work to Production. All Production brings together jobs and results awaiting verification across Builds.

## Tips

- **⌘K / Ctrl+K.** Open the command palette for navigation, sync, and export actions.
- **Theme.** Choose light, dark, or system. The sidebar can collapse to an icon rail.
- **Share Build.** Download a reference manifest or a Git-ready bundle. These contain source references and Plan choices, not model files. Recipients obtain models from their original sources. Manifest import is not yet available.
- **Spoolman.** Connect it in Settings → Integrations for live filament inventory and spool weights.
`;

const API_WORKFLOW_TIP = `
- **API.** OpenAPI is available at \`/api/v1/openapi.json\`. Self-hosted installations can require an API key.
`;

/** Full workflow context used by the built-in advisor when external tools are available. */
export const WORKFLOW_GUIDE = `${CORE_WORKFLOW_GUIDE}${API_WORKFLOW_TIP}`;

/** User-facing help follows the installation's chosen level of complexity. */
export function workflowGuideForExternalAccess(mode: ExternalAccessMode): string {
  return externalApiAccessEnabled(mode) ? WORKFLOW_GUIDE : CORE_WORKFLOW_GUIDE;
}
