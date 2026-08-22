/** Shared workflow markdown shown in Help and injected into the AI advisor context. */
export const WORKFLOW_GUIDE = `# Print Partner workflow

Print Partner helps you manage **layered STL kits** with a base repo and add-on repos through **Sources → Plan → Checkoff → Production**. Global navigation is Builds, Production, Printers, and Settings. **New Build** asks only for a name, then opens Sources. Opening an existing Build opens Plan.

## Managing Builds

- **Builds.** The home list. Search, filter, and open a Build into Plan.
- **Build picker.** Switch the active Build from the sidebar. Archived Builds stay listed as templates; selecting one does not unarchive.
- **New Build.** Find it under the picker in the sidebar or use the primary action on Builds.
- **Build overflow.** Rename, Duplicate, and Delete are here. Archive appears only when print remaining is 0.

The active Build is shared across Sources, Plan, Checkoff, and Production.

## 1. Source library

Register GitHub repos, local folders, or zip archives. Assign **categories**, set **import rules** (which folders contain STLs), and **sync** to download files. The source library shows sync status and **update available** badges when upstream repos change. Use the global STL search box to find files by name or path across every synced repo.

## 2. Sources

Open **Sources** for the active Build:

- **Attach sources** — set a base layer and optional add-on layers from your source library.
- **Pick STL files** — expand each source card, check files or folders to include; selections save automatically.
- **Role filament colors.** Assign a color per role (primary, accent, clear, opaque). Previews update automatically on Sources, Plan, and Checkoff.
- **Kit manifest options** — apply stack presets and variant picks on the base source card when manifests are configured.
- **Rebuild plan** — intentionally accepts the current source revisions, naming rules, and file picks, then rebuilds the parts list. Print Partner explains when those inputs have changed but never replaces the accepted list automatically.
- **Docs** — read synced repo README and Markdown inline from each source card.
- **Share build** — export a \`.print-partner-kit\` zip to share plan config (not STLs).
- **Export STLs.** Export from Sources or Plan, grouped by color only or color + source directory.

## 3. Plan

Confirm a **validation summary** grouped by role and filament. Browse the full included-parts list with **3D STL previews**, edit quantities, and fix issues (cards link back to Sources when needed). **Export STLs** writes parts organized by role and folder structure.

## 4. Checkoff

Track **per-unit print progress** on the shop floor (saved per Build). Filter to remaining or done parts, search, print an HTML checklist, and **Export remaining** STL units from this Build's checkoff for the next print batch. On-scroll **3D thumbnails** render client-side for each part.

## 5. Production

Allocate printers, edit plates, download files, track printer jobs, and verify completed prints. Global Production aggregates active jobs and work awaiting verification across Builds.

## Tips

- **⌘K / Ctrl+K.** Open the command palette for sync, exports, and navigation. Rebuild the parts list from Sources after reviewing its inputs.
- **Theme** — light, dark, or system via the sidebar or header; the left sidebar can be **collapsed** to an icon rail (toggle at the bottom).
- **Save / Import colors.** Export role colors as JSON on Sources. The **Advanced** menu has reset and thumbnail recovery options.
- **Share build** — export plan config as a \`.print-partner-kit\` zip (not STLs).
- **Spoolman.** Connect in Settings → Integrations for live filament inventory on Sources and spool weights in Plan / Checkoff. See the Spoolman integration doc in the repo.
- **API** — OpenAPI at \`/api/v1/openapi.json\` for automation; optional API key in self-host mode.
`;;
