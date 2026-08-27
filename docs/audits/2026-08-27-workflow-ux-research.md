# Cohesive workflow UX research

Date: 2026-08-27

## Decision

PrintPartner should treat Sources, Plan, Production, and Checkoff as one service, not four adjacent pages.

The current top-level order also needs correction. Preparing work is mostly linear, but making parts is a loop:

```text
Sources -> Plan -> Production <-> Checkoff
               accepted Plan     verified units
                      |                |
                      +-- remaining ---+
```

Sources prepares trustworthy inputs. Plan reviews and accepts a revision. Production prepares and sends a batch. Checkoff verifies the physical result. Incomplete or rejected units return to Production. A source change can send the Build back to Plan without erasing accepted work.

Keep all four workspaces, but stop presenting them as four completed-once steps. Group Sources and Plan as preparation. Group Production and Checkoff as an operating loop. The Build's state, next action, revision, and active printer work should come from one server-owned workflow projection that the browser and MCP both use.

This recommendation follows an end-to-end service view. GOV.UK advises teams to consider every user action, the internal processes behind it, and every channel involved. For PrintPartner, those channels include the browser, MCP conversation, local slicer, printer host, physical printer, and printed parts. [GOV.UK Service Manual, designing services](https://www.gov.uk/service-manual/design/introduction-designing-government-services) The USWDS continuity principle likewise calls for one experience across time, platforms, and devices instead of optimizing isolated tasks. [USWDS design principles](https://designsystem.digital.gov/design-principles/)

## Scope and method

This review covered:

- The four Build routes and their shared navigation.
- Working Plan drafts, accepted Plan revisions, Required-unit reconciliation, Plate revisions, printer handoff, and verification.
- Checked-in light-theme screenshots for all four stages.
- The MCP planning state added to Sources.
- Primary guidance from W3C, GOV.UK Design System and Service Manual, USWDS, and Apple Human Interface Guidelines.

The repository provides strong evidence about system behavior, but it does not replace user research. The operator recommendations below should be tested with people who prepare files at a desk and people who use Checkoff beside a printer.

## Current service map

| Workspace | What the user is trying to do | Current durable state | Current handoff |
| --- | --- | --- | --- |
| Sources | Assemble trustworthy inputs and choices | Attached source layers, source revisions, file choices, roles, colors, planning brief, open Plan draft | Rebuild a saved Plan draft |
| Plan | Decide exactly what the Build requires | Working draft plus accepted Plan revision | Apply a draft so downstream work changes |
| Production | Choose Required units, arrange Plates, export, slice, and send | Production setup, Plate revision, export artifacts, printer send records | Printer host and external slicer |
| Checkoff | Verify printed and assembled units | Unit progress, assembly progress, printer checkoff links, unattributed activity | Remaining units return to Production |

The domain model already has the right safety boundary. An accepted Plan revision owns Required units, checkoff state, Plate arrangements, exports, and printer handoff records. See `docs/ARCHITECTURE.md:88-101`. The main UX problem is that the interface does not explain this boundary consistently.

## Findings

### 1. The four-stage stepper describes a journey that is not linear

The shared stage model orders Checkoff before Production and styles Production as complete whenever a Build has parts. Checkoff is dimmed until one unit is printed. See `web/apps/web/src/lib/workflowStages.ts:103-139`.

The product behavior says something else:

- Plan links directly to either Checkoff or Production. See `web/apps/web/src/pages/PartsPage.tsx:167-197`.
- Checkoff's primary route prepares missing parts in Production. See `web/apps/web/src/pages/CheckoffPage.tsx:811-823`.
- Production selects units, arranges Plates, exports files, and sends G-code before Checkoff can verify printer results. See `web/apps/web/src/pages/ExportPage.tsx:200-303`.
- Printer send queues and completed-print verification then appear on Checkoff. See `web/apps/web/src/pages/CheckoffPage.tsx:868-936`.

USWDS says a step indicator is for a linear, multi-page sequence and should not itself act as navigation. It recommends another pattern when work is nonlinear or can occur in different orders. [USWDS step indicator](https://designsystem.digital.gov/components/step-indicator/)

**Design decision:** replace "Stage 1 of 4" semantics with location and state. In the rail, order the workspaces as Sources, Plan, Production, Checkoff. Visually group the last two as an operating loop. Each item needs a textual status such as "Needs review", "Revision 4 accepted", "2 jobs printing", or "3 units need verification". Do not mark Production complete merely because parts exist.

### 2. Navigation, progress, warnings, and next actions are calculated separately

The sidebar derives stage status from part count, source count, stale state, blockers, and printed percentage. `DeskNextStep` uses a second, much smaller rule set with fixed copy. See `web/apps/web/src/lib/workflowStages.ts:70-140` and `web/apps/web/src/lib/deskNextStep.ts:4-56`.

As a result, no element can answer all of these questions:

- What state is this Build in?
- What changed since the accepted Plan?
- Is the system working, waiting for the user, or blocked by an error?
- What should the user do next?
- Where can they do it?

The current next-step line cannot account for MCP confirmations, planning requirements, source sync jobs, Plan draft reconciliation, active Plate state, exported artifacts, queued sends, prints awaiting verification, or failures. It can only display generic advice.

**Design decision:** create one `BuildWorkflowWorkspace` read model. Every stage shell, next-action control, MCP response, and Build list row should consume the same projection.

```ts
type BuildWorkflowWorkspace = {
  build: { id: number; name: string };
  acceptedPlan: { revisionId: number; version: number } | null;
  workingChanges: { draftId: number; changeCount: number } | null;
  status: "needs_attention" | "working" | "ready" | "in_production" | "complete" | "error";
  stages: Array<{
    id: "sources" | "plan" | "production" | "checkoff";
    state: "not_started" | "needs_attention" | "in_progress" | "ready" | "complete" | "stale" | "error";
    label: string;
    summary: string;
    taskCount: number;
  }>;
  nextAction: {
    id: string;
    label: string;
    reason: string;
    route: string;
  } | null;
  activeWork: {
    queued: number;
    printing: number;
    awaitingVerification: number;
    remainingUnits: number;
  };
};
```

The exact type can change. The important rule is that one product module owns the meaning of every status and next action.

### 3. Sources contains setup, planning, draft review, and acceptance controls

Sources currently contains:

- The Build request.
- A "Rebuild plan" primary button.
- freshness warnings.
- the full saved-draft diff, reconciliation controls, and Apply button near the top.
- source attachment, source cards, file choices, roles, and warnings.
- a separate collapsed "AI Build planning" card near the bottom.

See `web/apps/web/src/pages/BuildPage.tsx:542-798` and `web/apps/web/src/pages/BuildPage.tsx:910-1101`. The MCP planning card has its own requirements, evidence, compatibility, blockers, and draft state. It fetches only when the Plan id changes. See `web/apps/web/src/components/build/BuildPlanningCard.tsx:36-203`.

The card can display "Ready to apply", but it renders no action or route. An MCP change can also leave the card stale because the fetch effect does not react to workflow mutations. This reproduces the reported failure mode: the interface names a state but does not say who can advance it or where the action lives.

Two pending states also share similar language. An MCP action proposal is session-scoped and requires `confirm_apply`. An open Plan draft is durable Build state and later becomes an accepted Plan revision. See `web/apps/server/src/mcp/product-mcp.ts:283-378` and `web/apps/server/src/services/build-planning.ts:718-865`. Calling both states "draft" or "ready to apply" obscures two separate checkpoints.

The user must interpret two kinds of draft, planning readiness, source readiness, accepted state, and Apply. The page owns too much of the transaction, while Plan lacks the final transaction control.

The written workflow assigns acceptance to Plan. `docs/playbooks/kit-studio-build.md:31-37` tells users to open Plan, review warnings, and select Apply. The browser renders the Apply control on Sources instead. This is more than a copy mismatch. The product and its instructions disagree about which workspace owns the checkpoint.

GOV.UK's task-list component is intended for related tasks that users may complete in an order that works for them. Each task has a short name, status, and optional hint. The whole row links to the task, and the task link is programmatically associated with its status. [GOV.UK task list](https://design-system.service.gov.uk/components/task-list/)

**Design decision:** make Sources a setup workspace with a short task list and one next action. Move full Plan diff review, reconciliation, and acceptance to Plan. Use separate labels for "Assistant changes awaiting confirmation", "Working Plan changes ready for review", and "Plan revision 5 accepted". Every pending state must name its owner and provide an action or an exact route. If assistant proposals remain session-scoped, say "Confirm in MCP". If the browser must confirm them, persist a Build-scoped action request with an actor, expiry, permissions, and idempotency key.

### 4. Plan edits working values but sends the user elsewhere to accept them

Plan supports quantity and inclusion editing. When a draft is open it explains that accepted values and Checkoff remain unchanged until Apply. See `web/apps/web/src/components/review/ReviewPartsSheet.tsx:535-540`. The Apply control is on Sources, not Plan. Plan's header instead offers Checkoff and Production even when there are unaccepted changes. See `web/apps/web/src/pages/PartsPage.tsx:167-197`.

The current issue list also combines blockers and warnings, sometimes linking "Go to Library" when the destination is the Build's Sources workspace. See `web/apps/web/src/pages/PartsPage.tsx:243-342`.

GOV.UK recommends a review page immediately before submission, divided into relevant sections, with specific Change links that return users to the review after an edit. The final button should name the action it performs. [GOV.UK check answers](https://design-system.service.gov.uk/patterns/check-answers/)

**Design decision:** Plan owns the review and acceptance checkpoint. Rename "Saved Plan draft" to "Working Plan changes" and "Apply plan changes" to "Accept Plan revision". Show the current accepted revision and working changes side by side. Only show Production and Checkoff as primary destinations after acceptance, or clearly label them as using the current accepted revision when working changes remain.

### 5. Production looks linear, but users may leave the product and return later

Production uses four numbered tabs: Parts, Plates and printers, Review and export, Send G-code. The tabs are also navigation, and the selected tab only lives in the URL. See `web/apps/web/src/pages/ExportPage.tsx:46-52` and `web/apps/web/src/pages/ExportPage.tsx:200-303`.

WAI defines tabs as layered sections that show one content panel at a time. The pattern does not represent completion, blocking, or sequence. The numbers add workflow meaning that the tab state does not carry. [WAI-ARIA Authoring Practices, tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)

The real task crosses systems:

1. Select incomplete units.
2. Assign printers and arrange Plates.
3. Export slicer input.
4. Leave PrintPartner and slice it.
5. Return with G-code.
6. Send or start it.
7. Wait.
8. Verify the result in Checkoff.

The numbered tabs imply one uninterrupted pass. They do not show whether a Plate is ready, which artifact was exported, whether the user is waiting on slicing, or whether a sent file maps to the selected Required units.

**Design decision:** replace numbered tabs with a durable "Production work package". A work package records the selected Required units, printer assignments, Plate revision, exported artifact, sliced-file handoff, send status, and linked verification state. Present its tasks as:

- Select work
- Assign printers
- Arrange Plates
- Export for slicing
- Add sliced file
- Send or start

Only truly blocked tasks are unavailable. Completed tasks remain reviewable. The page resumes at the first unfinished task after a reload or device change. A user may still jump to any available task.

### 6. Checkoff is doing verification, printer monitoring, queue dispatch, paper setup, sorting, and manual progress

Checkoff puts printer status, unattributed activity, queue suggestions, print verification, send queue controls, search and filters, print-sheet settings, drag reordering, bag separators, manual printed counts, and assembly state in one long page. See `web/apps/web/src/pages/CheckoffPage.tsx:773-1035`.

This page runs beside physical work. The operator may arrive because a printer finished, because they need to mark a manual print, or because they are packing completed parts. Those are different tasks with different urgency.

GOV.UK's cross-channel service guidance says front-line operations must be part of research and that digital changes should account for their effect on offline work. [GOV.UK joined-up channels](https://www.gov.uk/service-manual/service-standard/point-3-join-up-across-channels)

**Design decision:** make Checkoff a verify-first operator console:

1. "Needs verification" appears first and owns the primary action.
2. "Printing now" and "Queued" are status summaries with links back to Production. Queue dispatch controls live in Production.
3. "Remaining units" is the manual worklist.
4. "Completed" and "Assembly" are secondary views.
5. Paper layout controls move into the Print sheet action rather than occupying the page header.

When all Required units are verified, show a durable completion state with the accepted Plan revision, totals, completion time, and likely next actions. Confirmation guidance says the user should see what completed, a reference when available, and what happens next. [GOV.UK confirmation pages](https://design-system.service.gov.uk/patterns/confirmation-pages/)

### 7. Errors and background states are fragmented

The four pages mix inline alerts, stale-state banners, silent refresh failures, and Sonner toasts. Checkoff progress mutations, Production Plate conflicts, send failures, and source operations often report through toasts. Toasts are useful as immediate feedback, but they are a weak only record for a failed workflow action because they disappear and do not stay beside the task that needs repair.

GOV.UK recommends both a page-level error summary and an inline error beside each invalid answer. [GOV.UK error summary](https://design-system.service.gov.uk/components/error-summary/) WCAG requires automatically detected input errors to identify the item and describe the problem in text. [WCAG 2.2 error identification](https://www.w3.org/WAI/WCAG22/Understanding/error-identification)

**Design decision:** classify workflow states before choosing presentation.

| State | Presentation | Example |
| --- | --- | --- |
| User decision needed | Task status and direct action | Choose between conflicting source files |
| Background work | Inline progress with cancel or safe navigation | Syncing source revision |
| Dependency unavailable | Unavailable task with reason and route | Add a printer before assigning Plates |
| Recoverable operation failure | Persistent inline error and Retry | Plate arrangement failed |
| Multiple invalid decisions | Error summary plus inline messages | Required-unit mapping choices missing |
| Stale revision | Warning with review impact | Accepted Plan changed during Plate edit |
| Successful checkpoint | Persistent confirmation or receipt | Plan revision 5 accepted |

Every recoverable failure should preserve the user's choices. A retry should rerun the failed operation, not restart the stage.

### 8. Fixed chrome competes with operator content on small screens

The mobile shell stacks a fixed workflow bar above a fixed Plan tray. The Plan tray can be 60 pixels high, while page content receives hard-coded bottom padding. See `web/apps/web/src/layout/AppLayout.tsx:147-179` and `web/apps/web/src/components/PlanTray.tsx:89-126`.

WCAG reflow guidance warns that sticky or fixed content can obscure focus and make content difficult to read. [WCAG reflow and fixed content](https://www.w3.org/WAI/WCAG21/Understanding/reflow.html) GOV.UK recommends designing small-screen layouts first as one column rather than assuming a device. [GOV.UK layout](https://design-system.service.gov.uk/styles/layout/)

**Design decision:** use one persistent mobile navigation row. Remove the mobile Plan tray. Put the Build summary and next action in normal page flow below the header. On desktop, keep the left rail and use an optional non-sticky context column for task status. Do not add another sticky workflow card.

## Proposed experience

### Shared Build header

Every workspace starts with the same compact Build header:

```text
Voron 2.4 Workshop
Plan revision 4 accepted | 18 Required units | 11 verified

Next: Verify 2 completed print jobs                         [Review jobs]
```

If working Plan changes exist, the second line becomes:

```text
Plan revision 4 accepted | 7 working changes not yet accepted
```

The header is not a second stepper. It is a current-state summary and one next action. The stage navigation remains separate.

### Sources

Sources should answer, "Are the inputs ready for a Plan?"

Recommended sections:

1. **Setup tasks**
   - Confirm Build request
   - Attach a base source
   - Attach optional sources
   - Sync source revisions
   - Resolve source roles and differences
   - Assign materials or colors
   - Review assistant changes
2. **Attached sources**
   - Preserve the current source cards, previews, and file selection.
3. **Advanced source settings**
   - Categories, import rules, naming, and manifest controls.

The primary action is calculated from the first task that needs attention. When setup is ready, it becomes "Review working Plan". Rebuilding should happen automatically after a settled source change when safe, or appear as a task named "Update working Plan". "Rebuild plan" is implementation language and should not be the default primary action.

MCP proposals appear as a durable task named "Review assistant changes" with a human summary such as "2 source roles and 3 file choices". Confirmation in MCP or the browser resolves the same proposal.

### Plan

Plan should answer, "What will this revision require, and am I ready to accept it?"

Recommended order:

1. Accepted revision summary.
2. Working change summary with added, changed, removed, and unaffected counts.
3. Issues grouped as "Must resolve" and "Review recommended".
4. Parts and quantities with working values clearly marked.
5. Required-unit impact, including preserved completion and work that must be printed again.
6. Final review summary.
7. "Accept Plan revision".

When accepted, show a durable confirmation:

```text
Plan revision 5 accepted
18 Required units are current. 11 verified units were preserved.
[Prepare 7 remaining units] [View Checkoff]
```

If printer or checkoff records cannot move safely, explain the affected units by filename and outcome. Do not expose "rebase", "snapshot digest", "unsafe predecessor", or "remap" as the main user vocabulary.

### Production

Production should answer, "What am I making next, and where is it now?"

The default view shows active work packages first, then a "Prepare more units" action. Each package has a short status:

- Preparing
- Ready to slice
- Awaiting sliced file
- Ready to send
- Queued
- Printing
- Needs verification
- Failed
- Complete

The work package is the continuity object across PrintPartner, the slicer, the printer, and Checkoff. It should retain links to the accepted Plan revision, Required-unit tokens, Plate revision, export artifact, uploaded G-code, printer, send job, and verification result.

Plate drag editing needs Move, Transfer, and exact-position controls that work without dragging. WCAG 2.2 requires a simple pointer alternative for drag operations, independent of keyboard access. [WCAG 2.2 dragging movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html) The existing exact-position and transfer controls are a good base. The Checkoff reorder list needs equivalent up, down, and move-to controls.

### Checkoff

Checkoff should answer, "What physical result needs my attention?"

Use three views:

- **Needs attention:** completed printer jobs awaiting verification, failed jobs, and unmatched printer activity.
- **Remaining:** manual unit counters, printing state, and bag or sort grouping.
- **Completed:** verified units, assembly state, provenance, and correction controls.

On a phone, each row should prioritize filename, part image, current state, and one large primary action. Less frequent actions go in a menu. Use at least the WCAG 2.2 minimum 24 by 24 CSS pixel target with adequate spacing. For this shop-floor surface, target 44 by 44 for primary touch controls because Apple's accessibility guidance recommends 44 point default controls on touch platforms. [WCAG 2.2 target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) [Apple accessibility guidance](https://developer.apple.com/design/human-interface-guidelines/accessibility)

Manual decrement or rejection needs a short correction flow with a reason when that information affects printer history or material deduction. A successful host status must continue to require human verification, which matches the existing domain rule.

## Common interaction rules

### Task lists and stage navigation

- Use stage navigation to move between workspaces.
- Use task lists inside Sources and Production where tasks can be completed in more than one order.
- Use a review and confirmation checkpoint in Plan.
- Use prioritized queues in Checkoff.
- Do not nest another four or five step indicator inside the existing workflow.
- Never use a completion color without a text status. WCAG requires information conveyed by color to be available another way. [WCAG technique G14](https://www.w3.org/WAI/WCAG22/Techniques/general/G14.html)

### Status visibility

Each task and stage state must name both the state and the owner:

- "Needs your decision"
- "Syncing source"
- "Waiting for printer"
- "Needs verification"
- "Failed, retry available"
- "Complete"

Use `role="status"` or an equivalent polite live region for background progress and successful updates that do not move focus. WCAG requires assistive technology to receive status messages without a forced context change. [WCAG 2.2 status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages)

Use `role="alert"` only when immediate attention is justified. Too many alerts make every state look urgent and interrupt screen-reader users.

### Cross-page continuity

- Save task state on every meaningful mutation.
- Include the Build id, accepted Plan revision, working draft id, Plate revision, and work-package id in relevant URLs and API responses.
- Return the updated workflow projection after every browser or MCP mutation.
- Invalidate or subscribe to shared workflow state when MCP, a background sync, a printer poll, or another browser changes it.
- Preserve search, grouping, and draft choices when users leave and return.
- Show "Updated by assistant", "Updated in another tab", or "Source revision changed" when that fact explains a state change.
- Make pending assistant confirmations durable and Build-scoped rather than session-only.

The browser and MCP are two controls for the same Build. GOV.UK's joined-up channel guidance says users should receive a coherent service regardless of channel, and operational staff should not need workarounds for gaps between channels. [GOV.UK joined-up channels](https://www.gov.uk/service-manual/service-standard/point-3-join-up-across-channels)

### Responsive behavior

- Start every stage as a single-column phone layout.
- Keep one bottom navigation row on mobile.
- Put primary actions in normal flow and repeat them at the end only on long review pages.
- Convert wide comparison tables into summary cards on narrow screens. Keep a table option for dense desktop review.
- At 200 and 400 percent zoom, preserve logical reading and focus order and avoid two-dimensional scrolling except for genuine model or Plate canvases.
- Make sticky filters collapsible and ensure they never cover focused controls.
- Keep the visual and DOM order aligned. WCAG focus-order guidance requires sequential navigation to preserve meaning and operability. [WCAG 2.2 focus order](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html)

## Technical implications

### One workflow module

Add a server-side `BuildWorkflowWorkspace` module over existing repositories. It should own:

- stage states.
- task states and dependencies.
- the single next action.
- accepted versus working revision language.
- downstream impact summaries.
- active Production and Checkoff counts.
- pending assistant proposals.

The module should expose a stable read interface. It should not absorb source sync, Plan draft, Plate, printer, or checkoff mutations. Those deeper modules remain responsible for their invariants.

### One shared client query

Replace page-local status fetching with one shared query keyed by Build. Invalidate it after every relevant mutation. Poll or subscribe while source jobs, exports, printer work, or MCP confirmations are active. Refetch on browser focus as a fallback.

The existing Plan context already invalidates Plan review, profile, Checkoff, Plate, and export queries after applying a draft. See `web/apps/web/src/context/PlanWorkspaceContext.tsx:299-318`. Extend that discipline to a single workflow query rather than adding more component-local state.

### A durable Production work package

First try to project a work package from existing production selection, Plate revision, export job, printer handoff, and checkoff link records. If identity is ambiguous across those records, add a small durable entity that binds them. Do not build the new UX on URL tab state alone.

### Event and action contract

Every mutation response should include:

- what changed.
- the resulting durable id or revision.
- any user decision still required.
- the updated next action.
- whether downstream work was preserved, replaced, or made stale.

MCP tools should use this same contract. Low-level tools may remain for advanced clients, but the main workflow tools should return user-facing tasks and next actions rather than internal blocker codes.

## Prioritized redesign

### P0: make the workflow truthful

1. Change the visible order to Sources, Plan, Production, Checkoff.
2. Remove "Stage n of 4" completion language.
3. Stop marking Production complete when parts merely exist.
4. Introduce the server-owned workflow projection and exhaustive next-action resolver.
5. Give every stage a textual status and owner.
6. Make browser and MCP consume the same planning and pending-confirmation state.

This is the smallest change that prevents the shell from giving false guidance.

### P1: put each decision in the right workspace

1. Replace the split Sources planning cards with a setup task list.
2. Move Plan diff, Required-unit impact, reconciliation, and acceptance to Plan.
3. Rename user-facing draft and Apply language.
4. Add a durable acceptance confirmation with next actions.
5. Disable or qualify downstream primary actions when working changes are unaccepted.

### P1: rebuild the operating loop

1. Introduce Production work packages.
2. Replace numbered Production tabs with resumable tasks and statuses.
3. Keep queue dispatch and printer preparation in Production.
4. Put pending verification first on Checkoff.
5. Link rejected or incomplete units back to a preselected Production package.
6. Add a durable Build completion state.

### P2: make recovery, mobile use, and accessibility first-class

1. Replace toast-only failures with persistent task errors and Retry.
2. Add error summaries for multi-decision forms.
3. Remove the mobile Plan tray and test fixed chrome at high zoom.
4. Provide non-drag alternatives for Checkoff ordering and Plate movement.
5. Increase primary shop-floor targets to 44 by 44 and check spacing.
6. Test keyboard, screen reader, touch, 200 percent zoom, and 400 percent zoom journeys.

### P3: simplify after evidence

1. Remove obsolete status selectors and duplicate page-level next-step code.
2. Remove stale terminology and route aliases from user-facing copy.
3. Tune task grouping and defaults from observed operator behavior.
4. Consider renaming Checkoff to "Verify" only after testing. "Checkoff" is established in the product, while "Verify" states the action more directly.

## Validation plan

Test the complete service, not isolated pages.

### Core scenarios

- One local source with no conflicts.
- Multiple sources with file differences and role choices.
- MCP prepares a Build, browser confirms it, and MCP reconnects.
- A source revision changes after Plan acceptance.
- A new Plan revision preserves some verified units and replaces others.
- A user exports, leaves for a slicer, returns later on another device, and sends G-code.
- A printer finishes with matched objects, unmatched objects, or an error.
- A manual print is completed without a printer integration.
- A failed print returns selected units to Production.
- All units finish and the Build reaches a clear completion state.

### Operator sessions

Run contextual tests in two environments:

- Desk setup with keyboard, mouse, wide screen, and MCP.
- Shop-floor use with phone or tablet, touch input, printer noise, interruptions, and one-handed operation.

Observe whether users can answer these questions without opening another page:

1. What Build and accepted revision am I using?
2. What needs my attention now?
3. What happens if I use the primary action?
4. What is happening in the background?
5. Can I leave and resume safely?

### Measures

- Time from Build creation to accepted Plan revision.
- Number of reversals between Sources and Plan before acceptance.
- Failed acceptance attempts and their causes.
- Time from selecting units to export, and from export to send.
- Time a completed job waits for verification.
- Number of printer activities that need manual attribution.
- Recovery rate after stale revision or operation failure.
- MCP proposals completed after a reconnect.
- Wrong-unit checkoffs or corrections on mobile.

## Open questions for user research

- Do operators think in Builds, Plates, printer jobs, batches, or bags when choosing the next work?
- Should Production select individual Required units, parts, whole Plates, or all three depending on context?
- Does "Checkoff" communicate verification, or does it sound like a generic checklist?
- When an accepted Plan changes, which preservation choices are understandable without exposing revision terminology?
- Are paper print sheets a preparation task in Production or an operator aid in Checkoff?
- Should assembly progress remain in Checkoff or become a separate completion view?
- How often do desk and shop-floor work happen on different devices or by different people?
- Which MCP changes are safe to batch into one confirmation?

These answers should shape the final labels and task grouping. They should not delay the P0 correction to false stage status.

## Primary sources

- [GOV.UK Service Manual: Designing good government services](https://www.gov.uk/service-manual/design/introduction-designing-government-services)
- [GOV.UK Service Manual: Provide a joined-up experience across all channels](https://www.gov.uk/service-manual/service-standard/point-3-join-up-across-channels)
- [GOV.UK Design System: Task list](https://design-system.service.gov.uk/components/task-list/)
- [GOV.UK Design System: Check answers](https://design-system.service.gov.uk/patterns/check-answers/)
- [GOV.UK Design System: Confirmation pages](https://design-system.service.gov.uk/patterns/confirmation-pages/)
- [GOV.UK Design System: Error summary](https://design-system.service.gov.uk/components/error-summary/)
- [GOV.UK Design System: Layout](https://design-system.service.gov.uk/styles/layout/)
- [USWDS: Design principles](https://designsystem.digital.gov/design-principles/)
- [USWDS: Step indicator](https://designsystem.digital.gov/components/step-indicator/)
- [WAI-ARIA Authoring Practices: Tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)
- [W3C: WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [W3C: Understanding status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages)
- [W3C: Understanding error identification](https://www.w3.org/WAI/WCAG22/Understanding/error-identification)
- [W3C: Understanding target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
- [W3C: Understanding dragging movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)
- [W3C: Understanding focus order](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html)
- [W3C: Understanding reflow](https://www.w3.org/WAI/WCAG21/Understanding/reflow.html)
- [Apple Human Interface Guidelines: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
