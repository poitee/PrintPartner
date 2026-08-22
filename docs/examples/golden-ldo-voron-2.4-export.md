# Golden QA export for LDO 2.4 with Stealthburner and Tap

Export a **kit bundle** (`.print-partner-kit.zip`) after applying the `ldo_2.4_sb_tap` stack preset for regression and release smoke tests.

## Prerequisites

1. Add and sync `LDOVoron2`, `Voron-Stealthburner`, and `Voron-Tap` on **Sources**.
2. Set import rules on each repo (printed parts folders only).
3. Add the [cross-source Voron manifests](./cross-source-voron/ldo-2.4-golden-stack.md) to the repositories.

## Build the golden plan

1. Select **New Build** and enter `Golden LDO 2.4 SB Tap`.
2. On **Sources**, apply **LDO 2.4 + Stealthburner + Tap** (`ldo_2.4_sb_tap`) from the base source manifest options.
3. Confirm layers: base `LDOVoron2`, addons `Voron-Stealthburner`, `Voron-Tap`.
4. Confirm selections: `toolhead: stealthburner`, `probe: voron_tap`.
5. Pick STL files, set role colors, and rebuild the draft.
6. Open **Plan**, resolve warnings, and apply the draft.

## Export QA bundle

1. On **Production**, export the accepted Plan as a kit bundle.
2. Or start job: `POST /jobs/export-kit-bundle` with `{ "profile_id": <id> }`.
3. Save as `golden-ldo-2.4-sb-tap.print-partner-kit.zip` for CI or manual diff.

## Verify bundle contents

Unzip and check:

| Artifact | Expect |
|----------|--------|
| `manifest.json` / kit overlay | Selections match preset |
| STL paths | No stock toolhead/probe when SB + Tap selected |
| Layer refs | Base + two addon source names |

## Related docs

- End-user walkthrough: [golden-ldo-voron-2.4-sb-tap.md](./golden-ldo-voron-2.4-sb-tap.md)
- Community manifest: `manifests/community/ldo-2.4-sb-tap/manifest.yaml`
- Catalog preset: `stack_presets.ldo_2.4_sb_tap` in `docs/kit-catalog.yaml`
