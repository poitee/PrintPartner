# Library and Checkoff workflow

Date: 2026-08-31

## Decision

Use one ownership rule across the workflow:

- **Source Library** adds, syncs, and watches reusable projects.
- **Sources** attaches Library projects to one Build and chooses the files that Build needs.
- **Plan** reviews Required units and publishes the revision used on the shop floor.
- **Production** prepares and sends new work.
- **Checkoff** watches physical results, attributes missed or past prints, and verifies parts.
- **Printers** is the fleet-wide place to inspect one printer, browse its storage, and assign a file to any Build.

Past-print intake is not a Production method. It starts with a physical result or a file that already ran, so it belongs in Checkoff even when the file came from printer storage.

## Options considered

### A. Watch desk

Keep the catalog and monitoring controls together at the top of Source Library. Put a printer activity desk near the top of Checkoff, with direct actions to browse the fleet or add a past print.

Benefits:

- The primary action and its status stay on the same page.
- Existing source, printer, and Checkoff APIs remain useful.
- The Build workflow does not gain another stage or tab.
- A user can recover a missed print from either its Build or its printer.

Cost:

- Source Library and Checkoff each need a compact summary before their existing detailed content.

### B. Activity inbox

Add a global inbox with source updates, completed prints, unmatched jobs, and failures.

Benefits:

- All notifications have one destination.

Costs:

- The inbox duplicates the attention queue already owned by Checkoff.
- Source management becomes split between Library and Inbox.
- Every item needs another routing decision before the user can act.

## Chosen interaction

Use option A.

### Source Library

1. Show source monitoring before the catalog.
2. Keep **Add source**, **Check now**, **Sync GitHub**, repository-list import, schedule, and automatic refresh visible.
3. Show updates in the application, including updates that were refreshed automatically.
4. Treat GitHub repositories as automatically monitorable sources.
5. Treat Printables, MakerWorld, and Thangs URLs as tracked manual-download sources until a supported provider API exists.

### Build Sources

Explain the handoff in three short steps:

1. Add or update reusable projects in Source Library.
2. Attach the projects needed by this Build and choose folders or STL files.
3. Open Plan to review Required units and publish the working revision.

The explanation does not expose Plan draft state. Sources still answers only whether the Build inputs are ready.

### Checkoff and Printers

1. Keep live printer status visible near the top of Checkoff.
2. Put **Add past print** beside that status.
3. Let the user choose any watched printer and browse its storage.
4. Let the user upload G-code, binary G-code, or 3MF for an unmonitored printer.
5. Keep the dialog open after a successful record so several files or printers can be added in one session.
6. Keep **Printers** as the fleet-wide recovery path, where a stored or uploaded file can be assigned to any Build.

### Production compatibility

New Production choices are limited to preparing Plates or downloading STL files. Existing Builds whose stored method is `external` keep their history and receive a direct handoff to Checkoff; the stored value is not deleted during this UI migration.

## Acceptance

- Source Library is visually distinct in desktop and mobile navigation.
- An available source update is visible outside the Library page.
- Source monitoring schedule and automatic refresh are understandable without opening Discord settings.
- Printables, MakerWorld, and Thangs can be recorded with an honest manual-update state.
- Build Sources explains Library, attachment, file selection, and the Plan handoff.
- Production no longer offers past prints as a method for new work.
- Checkoff can browse watched printer files and upload files from unmonitored printers.
- Local uploads use the server upload token and can be assigned successfully.
- Several past prints can be recorded without losing earlier outcomes.
