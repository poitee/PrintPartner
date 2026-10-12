# HTML checklist parity fixtures

These accepted export captures are rendered through the TypeScript production
`materializeAcceptedChecklistHtml` entrypoint in
`web/apps/server/src/services/export-html.ts`. No renderer is mocked or copied.

- `single-layer`: quantities, roles, catalog/custom swatches, excluded parts,
  and HTML escaping in the profile name and notes.
- `multi-layer-addons`: base before addons, alphabetical addon and folder order,
  excluded addons, and escaping in the order number and notes.
- `checkoff-partly-done`: complete, partially complete, pending, and missing-unit
  checkoff. Only a full set of completed units receives a checkmark.

The test helper normalizes profile/part IDs and unit tokens before rendering,
uses profile ID `1` and generation time `2000-01-01T00:00:00.000Z`, and selects
ISO formatting to avoid host timezone differences. It creates and removes an
isolated temporary export directory for each render. These fixtures have no
tracked thumbnail artifacts and require no database, app server, or printers.

Run from `web/`:

```sh
# Uses development exports; no package build needed to regenerate.
node --conditions=development --import tsx scripts/export-html-golden.mts --write

# Build workspace packages once for Vitest's normal package resolution.
npm run build -w @print-partner/contracts
npm run build -w @print-partner/domain
npm run test -w @print-partner/server -- src/test/export-html-golden.test.ts
```

Vitest compares every rendered HTML byte with the committed expected file and
fails on drift; it never updates expected files. Review changes after explicit
regeneration. An additional test checks identity/time normalization and confirms
that a checkoff change remains visible.

`expected/screenshots/` contains visual references of these generated HTML
files in Chromium at 1280 × 800. They are review evidence, not image-comparison
goldens. To refresh them, serve `expected/` locally, open each `.html` in the
collaborative browser, inspect it, and save a screenshot. Update these references
when an intentional renderer change alters the HTML.
