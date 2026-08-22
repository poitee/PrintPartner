# Voron 2.4 and LDO 2.4 with Stealthburner and Tap

This example creates either a stock Voron 2.4 or LDO Voron 2.4 Build with Stealthburner and Tap.

## Two presets

Print Partner supports two reference stacks (both use Stealthburner + Tap as addons):

1. **Stock Voron 2.4:** base `Voron-2` with Stealthburner and Tap (`voron_2.4_stock_sb_tap`)
2. **LDO Voron 2.4:** base `LDOVoron2` with Stealthburner and Tap (`ldo_2.4_sb_tap`)

LDO is **not** layered on top of stock Voron-2 (avoids fork-duplication churn).

## Prerequisites

1. Add the required repositories to **Library**:
   - `Voron-2` and/or `LDOVoron2` (pick one as base)
   - `Voron-Stealthburner`, `Voron-Tap` (addons)
2. **Sync** each GitHub source and set import rules.
3. Add a manifest to each repository. See the [stack manifest playbook](../playbooks/author-manifest-on-stack.md) or the [cross-source Voron manifests](./cross-source-voron/ldo-2.4-golden-stack.md).

## Create the Build

1. Select **New Build** in the sidebar or on the Builds page.
2. Enter a name such as `Golden LDO 2.4 SB Tap`.

## Configure the sources

1. Open **Sources** for the new Build.
2. Attach synced `Voron-2` or `LDOVoron2` as the base source.
3. Attach `Voron-Stealthburner` and `Voron-Tap` as add-ons.
4. Apply the matching stack preset from the base source manifest options.
5. Review each variant and choose the required STL files.
6. Assign filament colors to the primary and accent roles.
7. Rebuild the draft.

## Apply and produce

1. Open **Plan** and resolve missing files, duplicates, or replacement warnings.
2. Apply the draft so Checkoff and Production use the new revision.
3. Track required units on **Checkoff**.
4. Arrange plates and export 3MF or STL files from **Production**.

## Maintainer checklist

| Step | Action |
|------|--------|
| Catalog | `stack_presets` + bases in `docs/kit-catalog.yaml` |
| Sources | Role + addon category tags |
| Manifests | Shared `toolhead` / `probe` ids; replacement globs |
| Maintenance | Re-sync sources after upstream changes |
| Golden Build | Rebuild and apply the Plan after upstream changes |

See [author-manifest-on-stack playbook](../playbooks/author-manifest-on-stack.md) for maintainer steps.
