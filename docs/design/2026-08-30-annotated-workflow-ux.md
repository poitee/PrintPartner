# Annotated workflow UX

## Decision

Use an intent-led workflow across Sources, Production, and Checkoff:

1. Make the active Build readable and give PrintPartner a recognizable mark.
2. Separate attaching a source from choosing the printable files inside it.
3. Name production methods by their output: generated 3MF plates, sorted STL downloads, or manually prepared prints.
4. Keep manual-print records independent so one session can cover several files and printers without hiding earlier successes.
5. Put unmatched prints, failed jobs, and parts awaiting verification under one `Attention needed` heading.

## Why this direction

The prior UI exposed internal terms such as `route`, `work package`, `picks`, and `assistant`. The revised copy follows the operator's decisions and reuses the existing APIs. Manual prints remain one record per file, which preserves precise printer and Required-unit attribution and makes partial failure visible.

## Key copy

- `Choose print files`: select folders or individual STL files from an attached source.
- `AI MCP Server changes`: changes proposed through the connected MCP server.
- `Generate 3MF plates`: arrange selected parts using printer build volumes and sorting choices.
- `Download sorted STL files`: organize selected STLs by color, material, type, and other sorting choices.
- `Add manually prepared prints`: record files sliced or sent outside PrintPartner; nothing is sent to a printer.

## Constraints

- Search and sorting apply to the currently open printer folder because the storage API is not recursive.
- Printer file rows show only metadata the host supplies: name, type, size, and modified time.
- Multiple manual prints use the existing single-record endpoint one at a time. Completed records stay visible and a new record may use another printer or file.
- Missing optional information is contextual guidance, never a new workflow blocker.

## Acceptance

- The active Build name is readable without opening the picker.
- Source attachment and file selection have distinct, plain-language actions.
- Both color tools are directly visible.
- MCP-originated changes explicitly name the AI MCP Server.
- Production method and next steps are understandable without `route` or `work package`.
- A session can retain several manual-print records across printers.
- Printer storage has current-folder search and name/date/size sorting.
- Production work that needs operator attention is grouped together.
