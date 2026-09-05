# Theme (instrument chrome)

Print Partner's desk UI uses the instrument design language (graphite carrier,
signal cyan, IBM Plex). Users choose appearance preference **system**, **light**,
or **dark** — there is no separate theme named "instrument."

## Sub-features

- `theme-settings` changes preference under Settings → Appearance.
- `theme-header` exposes the compact Theme control in the app header (md+).
- `theme-persist` stores `localStorage["print-partner.theme"]` and applies `.dark` on `<html>` when dark.

## How to get to it (user POV)

- Open **Settings** and use the Theme segmented control.
- Use the compact Theme control in the instrument header on desktop widths.

## Driving it with control-print-partner

Preconditions:

- Healthy verification instance (`doctor` pass).

- **Set dark.** Run
  `node .cursor/skills/verify-print-partner/helpers/control-print-partner.mjs theme --preference dark --out "$EVIDENCE/theme-dark.png"`.
  Response JSON includes `stored: "dark"` and a screenshot path.
- **Set light.** Run `… theme --preference light --out "$EVIDENCE/theme-light.png"`.
- **Open Settings chrome.** Run `… screenshot --path /settings --theme dark --out "$EVIDENCE/settings.png"`.

## Gotchas

- Preference values are only `system` | `light` | `dark`.
- Screenshot scripts also seed theme via `localStorage` init — that is fine for capture, but preference-change proof should go through the Theme control (`theme` command) when claiming UI interaction.
- Compact header control may be hidden below `md`; Settings path is the reliable entry.
