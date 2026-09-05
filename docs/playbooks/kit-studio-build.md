# Build from a stack preset

This playbook creates a Build from a base source, optional add-ons, and a stack preset.

## 1. Sync the sources

Open **Library** and add every repository used by the kit. Sync each source and confirm that its STL tree is available.

## 2. Create a Build

Select **New Build**, enter a clear name, and continue to Sources. You can also create or open a Build from the Builds page.

## 3. Attach sources

On **Sources**:

1. Attach the main kit repository as the base source.
2. Attach toolhead, probe, or other overlays as add-on sources.
3. Wait for source status to show that the selected revisions are ready.

## 4. Apply a preset or choose variants

If the base source matches a catalog entry, its manifest options show available stack presets. A preset attaches the expected sources and selects its default variants.

You can change any choice after applying the preset. Some groups allow one variant, any number of variants, or a bounded number. The picker shows the allowed count and prevents selections above the maximum. A group below its minimum contributes no parts until you select enough variants.

## 5. Select files and colors

Expand a source card to include or exclude files. Use the STL preview to confirm geometry. Assign colors or Spoolman filament to each role.

Changes update the draft. They do not replace the accepted Plan until you apply it.

## 6. Review and apply

Open **Plan** and review quantities, missing files, replacements, and other warnings. Resolve blocking warnings, then select **Apply**.

Checkoff and Production now use that accepted Plan revision.

## 7. Print and track

- Use **Checkoff** to track required units and assembly.
- Use **Production** to arrange plates and export 3MF or STL files.
- Slice the exported files in your chosen slicer.
- Return to Production to send sliced files to a linked printer.

## Troubleshooting

| Problem | Check |
|---------|-------|
| A preset is unavailable | Sync the source named by the preset and confirm its repository identity. |
| A choice is empty | Check the repository manifest and rebuild the draft. |
| The wrong files appear | Review the variant path globs and source import rules. |
| Checkoff still shows old units | Apply the current draft on Plan. |
| Preview colors did not update | Reapply the role color or regenerate thumbnails from the advanced controls. |

See [the golden LDO Voron 2.4 example](../examples/golden-ldo-voron-2.4-sb-tap.md).
