# Production

Production prepares the next batch: select required units, arrange plates,
export for slicing, and hand off to printers. It loops with Checkoff until the
Accepted Plan's required units are done.

## Sub-features

- `production-build` opens per-Build Production (`/export?profile=<id>`).
- `production-global` opens **All Production** (`/production`) across Builds.
- `production-plates` shows Prepare Plates when the Build has required units.
- `production-export-send` covers export / printer send panels (hardware-dependent).

## How to get to it (user POV)

- With a Build selected, choose the **Production** stage
  (path `/export?profile=<id>`).
- From the utility spine, choose **All Production** (path `/production`).
- Deep link for missing parts: `/export?profile=<id>&select=missing`.

## Driving it with control-print-partner

Preconditions:

- Healthy verification instance.
- Plate/export content needs an Accepted Plan with required units on disposable data.
- Printer send proof needs a configured printer — skip with an explicit unmet
  precondition rather than faking hardware.

- **Open Build Production.** Run
  `node .cursor/skills/verify-print-partner/helpers/control-print-partner.mjs navigate --path /export --theme dark`
  (add `--profile <id>`). Heading matches `Production`.
- **Open All Production.** Run `… navigate --path /production`.
- **Proof.** Run
  `… screenshot --path /export --out "$EVIDENCE/production.png"` and
  `… snapshot --path /export --out "$EVIDENCE/production.aria.txt"`.
- **Plates.** When present, assert heading `Prepare Plates` in the snapshot.

## Gotchas

- Stage link **Production** → `/export`; spine **All Production** → `/production`. Do not conflate them in proof notes.
- Export/send to a real printer is LAN/hardware territory — see [live-lan-walk.md](./live-lan-walk.md).
- Empty Production without an Accepted Plan is a valid empty-state proof, not a plate-arrangement proof.
