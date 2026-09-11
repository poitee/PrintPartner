# Checkoff

Checkoff verifies units that came off the printer against the **Accepted Plan**.
Incomplete or rejected units return to Production. Checkoff is not meaningful
without an Accepted Plan revision that owns required units.

## Sub-features

- `checkoff-open` opens Checkoff for a selected Build.
- `checkoff-empty-no-accepted` shows empty/notice state when no Accepted Plan units exist.
- `checkoff-worklist` lists required parts for verification after acceptance.
- `checkoff-print-sheet` opens the print sheet affordance when available.

## How to get to it (user POV)

- With a Build selected, choose the **Checkoff** stage (path `/progress?profile=<id>`).
- Legacy `/checkoff` redirects to `/progress`.
- Past-print intake deep link: `/progress?profile=<id>&add=past-print`.

## Driving it with control-print-partner

Preconditions:

- Healthy verification instance.
- For worklist proof: disposable Build with an Accepted Plan that has required units.
- Without Accepted Plan: prove the empty/notice path only.

- **Open Checkoff.** Run
  `node .cursor/skills/verify-print-partner/helpers/control-print-partner.mjs navigate --path /progress --theme dark`
  (add `--profile <id>` when driving a Build). Heading is `Checkoff`.
- **Proof.** Run
  `… screenshot --path /progress --out "$EVIDENCE/checkoff.png"` and
  `… snapshot --path /progress --out "$EVIDENCE/checkoff.aria.txt"`.
- **Search (when parts exist).** Snapshot or interact with `Search progress parts`.
- **Print sheet.** When the control is present, click role `button` name `/Print sheet/i`
  and capture the resulting sheet state.

## Gotchas

- Checkoff tracks the Accepted Plan — editing Sources/Plan without accepting does not change required Checkoff units.
- Do not invent progress by writing the database; drive UI or documented API on disposable data only.
- Cloud verification cannot open a real printer job on the LAN Core One; that belongs to [live-lan-walk.md](./live-lan-walk.md).
