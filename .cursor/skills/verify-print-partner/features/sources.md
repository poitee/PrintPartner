# Source Library and Build Sources

Source Library registers shared inputs (GitHub, folders, zips). Build Sources
attaches Library projects to one Build. Choosing STL files, quantities, and
colors happens on Plan — not on Sources.

## Sub-features

- `library-open` opens the shared Source Library.
- `library-empty` shows an empty or loading Library without a selected Build.
- `sources-open` opens Build Sources for a selected Build (`?profile=<id>`).
- `sources-attach` offers `Attach from Library` to add Library projects to the Build.

## How to get to it (user POV)

- Choose **Source Library** in the utility spine (path `/library`).
- From Builds, open a Build, then choose the **Sources** stage under Build Workflow
  (path `/sources?profile=<id>`).
- Legacy `/build` redirects to `/sources`.

## Driving it with control-print-partner

Preconditions:

- `control-print-partner doctor` reports Docker (or npm) instance healthy.
- No requirement for an Accepted Plan.

- **Open Library.** Run
  `node .cursor/skills/verify-print-partner/helpers/control-print-partner.mjs navigate --path /library --theme dark`.
  Heading is `Source Library`.
- **Proof Library.** Run
  `… snapshot --path /library --out "$EVIDENCE/sources-library.aria.txt"` and
  `… screenshot --path /library --out "$EVIDENCE/sources-library.png"`.
  Artifacts show heading `Source Library` and instrument chrome.
- **Open Builds.** Run `… navigate --path /builds`. Heading is `Builds`.
- **Open Build Sources (when a Build exists).** Run
  `… navigate --path /sources --profile <id>`. Heading matches `Sources`.
  Visible copy points users to Plan for files, quantities, and colors.
- **Attach affordance.** With a Build selected, confirm button `Attach from Library`
  via snapshot text or `… click --path /sources --profile <id> --role button --name "Attach from Library"`
  when proving the attach dialog (dispose any created fixture afterward).

## Gotchas

- **Library ≠ Build Sources.** `/library` is shared; `/sources` is per-Build.
- README stage table text can lag the UI: Plan owns file/qty/color choices.
- Without `profile`, Sources may show an empty “No Build selected” state — still a valid proof of the empty path, not of attach.
- Do not use the LAN live walk to claim cloud verification of Library sync against Chad's machine.
