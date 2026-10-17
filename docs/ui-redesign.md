# UI and workflow redesign

A proposal for how Print Partner's screens and Build workflow should work next. It is
a design, not a change to the product yet. The screens live on a design canvas:
<https://claude.ai/artifact/7KmCjrFoMDHSVynajdRkGx> (the row titled "v3"). Earlier
rows on the same canvas are superseded explorations and are kept only for comparison.

## Goal

A person opens a Build, supplies sources, sets quantities, materials, and colors, and
tracks what gets made. The app helps without getting in the way: every suggestion can
be declined, every optional step can be skipped, and nothing waits on a step the person
did not choose to take. The same screens serve one person with one printer and a print
farm with a queue.

## What stays

- The Build workflow from [ADR 0001](adr/0001-model-build-workflow-as-preparation-and-making.md):
  `Sources -> Plan -> (Production <-> Checkoff)`. Production and Checkoff still repeat.
- The invariant behind that ADR: printer work always references an accepted Plan
  revision. Required units, Checkoff state, plates, exports, and handoff records keep
  belonging to that revision.
- The Build workflow projection and its next-action vocabulary
  (`web/packages/contracts/src/build-workflow.ts`). The redesign is built on it rather
  than beside it.
- The [design system](design-system.md): surfaces, type scale, rhythm, status tones with
  a word and an icon on every colored state, 44 px targets, dark as the default.
- The contextual split from [ADR 0002](adr/0002-keep-sources-and-plan-state-contextual.md):
  Sources knows whether inputs are ready; Plan owns the Working Plan and acceptance.

## What changes

### 1. Two destinations per Build instead of four

The rail shows **Setup** and **Track** under "This Build". Setup is Sources and Plan on
one screen: sources, the parts table (quantity, material, color), and a tray of
decisions and suggestions. Track is Production and Checkoff on one screen: the Build's
next action, what is on the printer, what is remaining, and the log.

The four stages still exist in the projection and in the API. They stop being four
places the person has to visit.

### 2. The Next band is the projection's next action

Every Build screen opens with one band that shows the next action the projection
already computes (`verify_prints`, `prepare_production`, `attach_sources`, and the
rest). The band holds the only filled button on the screen. Builds lists the same band
per Build so a person can see what each one needs without opening it.

### 3. Plan changes reach printers automatically, unless the Build says otherwise

A per-Build setting, on by default for new Builds:

> Apply plan changes automatically when nothing needs a decision.

With it on, the app accepts a Working Plan revision as soon as it has no open
decisions, so quantity and color edits flow to Production without a review step. The
acceptance boundary still exists; the person is no longer asked to operate it.

With it off (a print farm, or a Build with a customer sign-off), each revision waits
for review before Production uses it. This is today's behavior.

Issues split into two kinds:

- **Defaults**: a missing quantity is 1, an unset part color is the role color, an
  unset material is the Build's default material. These are no longer issues. They
  show as values in the parts table, marked as defaults, and as suggestions when the
  app has a better guess.
- **Decisions**: differences between overlapping sources, stale sources, and anything
  else with no safe default. A decision shows in Setup's tray, and Production keeps
  running on the last accepted revision until it is made. `resolve_plan_issues` becomes
  a tray item rather than the Build's next action while automatic acceptance is on.

### 4. Suggestions wait in a tray

Suggestions (a material the person used before, a layer height from the last plate, a
Library folder that matches a Build, a duplicate file) sit in a tray with Apply and
Dismiss. A dismissed suggestion stays dismissed for that Build. The tray can be hidden
per Build.

### 5. Track has a solo view and a farm view over the same data

- **Solo**: the next finished units to check, one printer, remaining units with
  "Add G-code" and "Log a print by hand", and the history.
- **Farm**: printer lanes, a queue that sends the next plate to a free printer of the
  right material, finished plates to check, and printers that need a hand.

Switching views changes nothing in the data. A Build can switch at any time.

### 6. Checkoff is a decision, not a stage to visit

Finished units appear in the Next band with a Good chip per part and a Reject link,
then one "Confirm N units" button. The band states the result before the click
("made goes from 17 to 21 of 35"). Rejected units return to remaining and re-queue.
Status and history stay separate, so an old status never hides a logged print.

### 7. Library gets bundles and combinable filters

Files in one folder or zip show as one bundle row with a part count and a chevron.
Filters are chips with an All / Any / Exclude combinator. Watched folders and import
rules sit beside the list. Duplicates are shown, never deleted on their own.

### 8. Phone layout

A bottom bar with Builds, Track, Printers, and More replaces the rail. The Next band
is first. Every control is 44 px.

## Screen inventory (canvas row "v3")

| Artboard | Shows |
| --- | --- |
| Workflow, v3 | The loop, the automatic-acceptance switch, the 14 next-action kinds, the rules every screen follows |
| Builds | The Build list with a Next band per Build and a Library suggestion |
| Setup | Sources, the parts table with a bulk bar, the decisions and suggestions tray, the acceptance setting |
| Track, solo view | Next band with 4 units to check, printer, remaining, history |
| Track, farm view | Next band with 2 plates to check, four printer lanes, the queue |
| Library | Bundles, filter chips, watched folders, import rules, duplicates |
| Track, light theme | The solo view on the light palette |
| Track, phone | The solo view at 390 px with the bottom bar |

## Mapping to the code

| Design element | Existing code it builds on |
| --- | --- |
| Next band | `BuildWorkflowNextAction` in `web/packages/contracts/src/build-workflow.ts`; `components/layout/DeskNextStep.tsx` |
| Rail | `components/layout/SpineRail.tsx`, `MobileNavDrawer.tsx` |
| Status chips | `lib/statusTone.ts`, `components/ui/status-badge` |
| Setup | `pages/SourcesPage.tsx` and `pages/PartsPage.tsx` (routes `/sources`, `/plan`) |
| Track | `pages/CheckoffPage.tsx`, `pages/ExportPage.tsx`, `pages/GlobalProductionPage.tsx` (routes `/progress`, `/export`, `/production`) |
| Automatic acceptance | A Build-level setting read by the projection; `accept_working_plan` fires without a user action when the Working Plan has no decisions |
| Part colors | `docs/part-colors.md`; role color as the default |

## Open decisions

1. **Automatic acceptance by default.** This is the one change that touches the ADR 0001
   boundary. The invariant holds; the default changes. If the maintainers want review
   to stay the default, the setting ships off and the rest of the redesign stands.
2. **Farm queue sends on its own.** The farm view assumes a queued plate goes to a free
   printer without a click. A "send when I confirm" mode is a one-line addition to the
   same setting.
3. **Naming.** "Setup" and "Track" are proposals. "Prepare" and "Make" from the current
   rail groups also work and keep the ADR's words.

## Out of scope

Implementation, the Rust core, MCP tool changes, and the desktop shell. Printers and
Settings pages are unchanged.
