# Plan

Plan is where a Build's working intent lives: choose files, quantities, and
colors, resolve issues, then accept a Plan revision. Acceptance is the safety
boundary before Production and Checkoff.

## Sub-features

- `plan-open` opens Plan for a selected Build.
- `plan-files-qty-colors` shows file selection, quantity steppers, and colors/materials.
- `plan-accept` accepts a Plan revision (mutation — use disposable data only).

## How to get to it (user POV)

- With a Build selected, choose the **Plan** stage in Build Workflow
  (path `/plan?profile=<id>`).
- From Sources, follow **Open Plan** when offered.
- Legacy `/parts`, `/review`, `/plate`, `/print` redirect to `/plan`.

## Driving it with control-print-partner

Preconditions:

- Healthy verification instance (`doctor` pass).
- For file/qty UI: a Build with at least one attached source and selectable STLs
  (seed via Library + Sources on disposable data, or accept empty-state proof).
- Never accept a Plan against LAN/production data.

- **Open Plan empty/selected.** Run
  `node .cursor/skills/verify-print-partner/helpers/control-print-partner.mjs navigate --path /plan --theme dark`
  (add `--profile <id>` when driving a Build). Heading is `Plan` or empty-state
  `No Build selected`.
- **Proof chrome.** Run
  `… screenshot --path /plan --out "$EVIDENCE/plan.png"` and
  `… snapshot --path /plan --out "$EVIDENCE/plan.aria.txt"`.
- **Quantities (when files present).** Prefer accessible names
  `Increase quantity for <filename>`, `Decrease quantity for <filename>`,
  `Quantity for <filename>` via `click` / snapshot assertions.
- **Colors.** Snapshot should include heading `Colors and materials` when the
  Build has Plan content.
- **Accept (mutation).** Only on the disposable verification data dir. Drive the
  visible accept/apply control named in the UI for that revision, then reopen
  Plan or Checkoff to confirm Accepted Plan state. Capture before/after screenshots.

## Gotchas

- Plan owns files/qty/colors; Sources only attaches Library projects.
- Accepting a Plan publishes required units — do this only on isolated verify data.
- Thumbnail canvases may load slowly; wait or treat canvas absence as non-blocking for chrome proof.
- A screenshot of an empty Plan does not prove quantity steppers; say which sub-feature you proved.
