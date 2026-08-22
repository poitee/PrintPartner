# LDO Voron 2.4 golden stack manifests

Two **stack presets** are supported. See `stack_presets` in `docs/kit-catalog.yaml`.

| Preset | Base repo | Addons |
|--------|-----------|--------|
| **Voron 2.4 (stock) + SB + Tap** | `Voron-2` | `Voron-Stealthburner`, `Voron-Tap` |
| **LDO 2.4 + SB + Tap** | `LDOVoron2` | `Voron-Stealthburner`, `Voron-Tap` |

Do **not** overlay LDO on Voron-2. LDO repositories are near-forks, so use `LDOVoron2` as the base for LDO Builds.

## Manifests by repo

| Source | Role | Manifest |
|--------|------|----------|
| `Voron-2` | Base (stock preset) | [voron-2-base.manifest.yaml](./voron-2-base.manifest.yaml) |
| `LDOVoron2` | Base (LDO preset) | [ldo-voron2-base.manifest.yaml](./ldo-voron2-base.manifest.yaml) |
| `Voron-Stealthburner` | Toolhead addon (both) | [stealthburner-addon.manifest.yaml](./stealthburner-addon.manifest.yaml) |
| `Voron-Tap` | Probe addon (both) | [voron-tap-addon.manifest.yaml](./voron-tap-addon.manifest.yaml) |
| `LDO-Extras` | Z drives (optional) | Local folder source; not available through GitHub import |
| `Voron-Extras` | Skirts (optional) | [template-addon-pick_any.manifest.yaml](../template-addon-pick_any.manifest.yaml) |

Shared category ids (`toolhead`, `probe`) let SB/Tap addons merge into either base.

**Build page:** apply a stack preset card on the base source, pick variants, then **Update build**. See [Build playbook](../../playbooks/kit-studio-build.md).

See [README](./README.md) for cross-source replacement and umbilical examples.
