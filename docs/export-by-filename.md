# Export STLs by color and filename group

Use filename groups to download parts that share a color role and a print-setting category. The STL geometry stays unchanged. Apply the print settings in your slicer.

1. Open your Build's Production page.
2. Choose **Download sorted STL files** as the production method.
3. Open the download task.
4. Enable **Group by filename rules, such as print settings**.
5. Name your grouping and edit its suffix rules. For Milo, **Use Milo rules** assigns `-A` to Aesthetic, `-SS` to Semi-structural, and `-S` to Structural.
6. Open **Preview matches and assign exceptions** to inspect the included Plan files. Choose an override for any file that needs a different group.
7. Select **Save groups** to retain the definition for this Build. Unsaved edits apply to the current download but do not survive reopening the editor.
8. Choose a folder order. To create folders such as `accent/Structural/`, choose color first.
9. To download just one combination, choose `accent` under **Color role** and `Structural` under **Export group**.
10. Select **Download sorted STL files**, then **Save the files**.

Suffix rules ignore case and match the filename ending before `.stl`. The accent prefix `[a]` is independent of the aesthetic suffix `-A`.

If a file matches different groups, correct the rules or assign an override before downloading that file. Files without a match go into **Unassigned** when exporting all groups.

The preview shows included Plan parts. Required-unit selections and the remaining-only option further restrict the download. Excluded parts do not return to the Plan, and each exported unit retains its own file.

This version stores one named grouping per Build. It does not change plate generation, Plan sorting, shared manifests, or slicer settings.
