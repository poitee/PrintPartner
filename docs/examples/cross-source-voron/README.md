# Cross-source Voron example manifests

These files are minimal `print-partner.manifest.yaml` examples for a Voron base with Stealthburner and an umbilical add-on. Copy each manifest to its source repository root, or use it as a reference for a community manifest.

For the **LDO Voron 2.4 golden build** (SB + Tap), see [ldo-2.4-golden-stack.md](./ldo-2.4-golden-stack.md) for which repos need manifests.

| File | Role | Notes |
|------|------|-------|
| [voron-base.manifest.yaml](./voron-base.manifest.yaml) | base | Required frame + stock toolhead slot |
| [stealthburner-addon.manifest.yaml](./stealthburner-addon.manifest.yaml) | addon | `toolhead` setup, hull replacement, excludes stock paths |
| [umbilical-addon.manifest.yaml](./umbilical-addon.manifest.yaml) | addon | `cable_routing` slot + second `toolhead` variant |

After saving the manifests, sync each repository in **Library**. Attach the sources, rebuild the draft on **Sources**, apply it on **Plan**, and arrange the parts on **Production**.

For manifest authoring and application, see the [stack manifest playbook](../../playbooks/author-manifest-on-stack.md).
