# Production workspace UX research

Date: 2026-08-23

## Question

How should PrintPartner handle a Build with many parts, plate assignment, printer assignment, and final export or send? Should Build Production keep every control on one page?

## Recommendation

Keep one Build Production workspace and one durable state model, but divide the workspace into four task stages:

1. **Parts**: find, filter, group, and choose the required units.
2. **Plates**: pack the chosen units and inspect one active plate at a time.
3. **Printers**: assign a compatible physical printer to each plate.
4. **Review & send**: resolve blockers, then export, upload, queue, or start each plate.

Do not render every part row, plate editor, printer control, and export action as one continuous page. Established tools keep the project together while separating preparation, preview, printer handoff, and printer monitoring. A stage switcher inside `/export` preserves context without making the operator scan the whole workflow on every visit.

The current printer-selection defect is more than a display problem. PrintPartner should store the printer assignment on the plate or production plan. **Fill by source** and the review stage must read that same stored assignment. A selected value that exists only inside a dropdown cannot support later actions or survive a reload.

## What established tools do

### Large part sets use hierarchy, instances, and scoped bulk actions

PrusaSlicer's Object list is a tree of objects, instances, object settings, modifiers, and support controls. It lets the operator rename unclear CAD names and turn an object's printable state on or off. The hierarchy gives repeated or related items a compact representation instead of one flat row per mesh. See [Object list](https://help.prusa3d.com/article/object-list_1758).

PrusaSlicer treats repeated copies as instances that share settings and orientation. The operator can set an instance count, fill a bed with instances, or separate one instance when it needs independent treatment. See [Copy, paste, instances](https://help.prusa3d.com/article/copy-paste-instances_1769).

Selection works in both the 3D view and the Object list. The operator can add items to a selection, box-select, box-deselect, or select all. See [Selecting models](https://help.prusa3d.com/article/selecting-models_1763). Auto-arrange can apply to all objects or only the selected subset while leaving other objects fixed. See [Auto-arrange tool](https://help.prusa3d.com/article/auto-arrange-tool_1770).

PrintPartner should use the same shape for a large Build:

- Group required units by source or logical part by default.
- Collapse completed groups and show a count such as `corner_bracket × 8`.
- Keep search and filters visible. Useful filters include unassigned, not on a plate, incompatible, and ready.
- Apply bulk actions to the current selection or group, not only to the entire Build.
- Let the operator expand a group to handle an exceptional unit without losing the group-level assignment.

### A plate is the working batch

PrusaSlicer 2.9 supports up to nine build plates in one project. One plate is active, imports target the active plate, and the UI offers separate actions for arranging every plate and arranging only the current plate. Preview and export controls also follow the active plate. The operator can still slice or export all plates in bulk. All plates share one printer configuration. See [Multiple build plates on PrusaSlicer](https://help.prusa3d.com/article/multiple-build-plates-on-prusaslicer_823894).

Prusa EasyPrint moves objects to a named target bed, keeps one bed active, and can print either the active bed or all beds. Each bed slices separately and produces its own print file. See [EasyPrint](https://help.prusa3d.com/article/easyprint_898029).

These patterns suggest that PrintPartner should make the plate, not the individual unit, the main production batch. The plate list can show every plate in compact form, but only the active plate needs its full parts list, placement controls, and printer assignment open. Bulk actions can still operate across selected plates.

Bambu Studio follows the same rule in its current source. Its main actions are **Slice plate** and **Print plate**. **Slice all**, **Print all**, **Send all**, multi-device actions, and all-plate exports are secondary menu choices. See Bambu Studio's [`MainFrame.cpp` plate actions](https://github.com/bambulab/BambuStudio/blob/926a7192574bcb9b3a732e1ec59a46d79cb45466/src/slic3r/GUI/MainFrame.cpp#L1990-L2009) and [bulk actions](https://github.com/bambulab/BambuStudio/blob/926a7192574bcb9b3a732e1ec59a46d79cb45466/src/slic3r/GUI/MainFrame.cpp#L2281-L2389). The official command-line interface also targets either one plate by index or all plates. See [Bambu Studio Command Line Usage](https://github.com/bambulab/BambuStudio/wiki/Command-Line-Usage).

### Slicers separate preparation, review, and printer work

Bambu Studio creates distinct **Prepare**, **Preview**, and **Device** tabs in its main frame. See the tab definitions in [`MainFrame.cpp`](https://github.com/bambulab/BambuStudio/blob/926a7192574bcb9b3a732e1ec59a46d79cb45466/src/slic3r/GUI/MainFrame.cpp#L1040-L1045) and the workspace switch in [`MainFrame.cpp`](https://github.com/bambulab/BambuStudio/blob/926a7192574bcb9b3a732e1ec59a46d79cb45466/src/slic3r/GUI/MainFrame.cpp#L1514-L1518). This is one project window, not one continuous control surface.

Bambu Studio's current object browser adds a search field for plates, objects, and parts. Search results preserve the plate, object, and part path. See [`Plater.cpp`](https://github.com/bambulab/BambuStudio/blob/926a7192574bcb9b3a732e1ec59a46d79cb45466/src/slic3r/GUI/Plater.cpp#L3170-L3203) and [`ObjectDataViewModel.cpp`](https://github.com/bambulab/BambuStudio/blob/926a7192574bcb9b3a732e1ec59a46d79cb45466/src/slic3r/GUI/ObjectDataViewModel.cpp#L1565-L1623). OrcaSlicer documents an Object Set as a group of objects and parts. Its instances share parts, size, and settings while retaining independent position and rotation. See [OrcaSlicer Object Set](https://github.com/OrcaSlicer/OrcaSlicer/wiki/prepare_object_set).

OrcaSlicer's source uses a plate-first object tree and an **Outside** group for objects that are not assigned to a plate. Objects nest under plates, and repeated instances nest under their source object. See OrcaSlicer's [`ObjectDataViewModel.cpp`](https://github.com/OrcaSlicer/OrcaSlicer/blob/main/src/slic3r/GUI/ObjectDataViewModel.cpp#L494-L539). This gives PrintPartner a useful model for an unresolved or unplaced group that stays visible without mixing those units into every ready plate.

OrcaSlicer's bulk tools retain a clear action scope. It supports multiple selection, select all in the object list, arrange all, and arrange selected plates. See [OrcaSlicer Keyboard Shortcuts](https://github.com/OrcaSlicer/OrcaSlicer/wiki/keyboard_shortcuts) and [OrcaSlicer Auto Arrange](https://github.com/OrcaSlicer/OrcaSlicer/wiki/prepare_auto_arrange).

The important design lesson is not to copy desktop slicer tabs literally. PrintPartner should keep preparation, review, and printer dispatch visible as stages of one Build while showing only the controls for the current stage.

### Printer configuration and job handoff are separate concerns

PrusaSlicer separates a slicer Printer profile from a Physical printer profile that contains the network connection. One physical printer can link to more than one compatible slicer profile. Once a physical printer is selected and configured, the slicer can send generated G-code to it. See [Sending G-codes to printer via network](https://help.prusa3d.com/article/sending-g-codes-to-printer-via-network-prusa-connect-prusalink-octoprint_196761).

Bambu Studio checks the selected physical printer against the printer preset used to prepare the job. If they conflict, the send dialog tells the operator either to change the preset in **Prepare** or to choose a compatible printer. See [`SelectMachine.cpp`](https://github.com/bambulab/BambuStudio/blob/926a7192574bcb9b3a732e1ec59a46d79cb45466/src/slic3r/GUI/SelectMachine.cpp#L1944-L1976). Its fleet flow moves multi-printer selection to a separate table and limits select-all to printable devices. See [`SendMultiMachinePage.cpp`](https://github.com/bambulab/BambuStudio/blob/926a7192574bcb9b3a732e1ec59a46d79cb45466/src/slic3r/GUI/SendMultiMachinePage.cpp#L1206-L1245).

EasyPrint also separates configuration from handoff. The operator first chooses print settings, then starts slicing. After slicing, a Print Overview shows time and material. EasyPrint starts an idle, correctly loaded printer or adds the G-code to that printer's queue. The G-code preview remains an optional final check. See [EasyPrint](https://help.prusa3d.com/article/easyprint_898029).

OctoPrint's first-party API models upload, selection, and print start as distinct choices. An upload may remain only a file, select the file, or select and start it. The job API then manages the currently selected job. See [OctoPrint file operations](https://docs.octoprint.org/en/main/api/files.html) and [OctoPrint job operations](https://docs.octoprint.org/en/main/api/job.html).

Moonraker also separates file management from a FIFO job queue. Clients can enqueue several files in order, inspect the queue, pause it, and remove jobs. See [Moonraker Job Queue Management](https://moonraker.readthedocs.io/en/latest/external_api/job_queue/) and [Moonraker File Management](https://moonraker.readthedocs.io/en/latest/external_api/file_manager/). Mainsail exposes the same separation as integrated file management, a job queue, and multi-printer monitoring. See the official [Mainsail documentation](https://docs.mainsail.xyz/) and [Mainsail repository](https://github.com/mainsail-crew/mainsail).

PrintPartner should therefore keep four actions distinct in its UI and data:

- **Export** downloads a file.
- **Upload** sends a file to a printer without scheduling it.
- **Queue** schedules the plate after other work.
- **Start** asks an available printer to print now.

The review stage can offer only the actions supported by the assigned printer. It should not make operators infer whether a generic **Export** or **Send** button also queues or starts a print.

## Proposed Build Production structure

### Parts

Start with source groups collapsed. Each group shows selected units, total units, plate coverage, and unresolved issues. Search should match the display name, source, variant, and file path. A compact density should be the default for large Builds.

Put bulk actions near the selection summary:

- Select all visible.
- Add selected to a new plate.
- Add selected to the active plate.
- Fill plates from selected units.
- Hide completed.

The full file metadata and 3D preview belong in an expandable detail area, not every list row.

### Plates

Show a compact plate rail or card grid with the plate name, printer requirement, unit count, estimated material, validation state, and assigned printer. Open only the active plate's full editor. Keep **Arrange active plate** separate from **Arrange all unplaced units**.

Give each plate a stable ID. Store unit membership and overrides against that ID. Renaming, sorting, filtering, or changing the active plate must not change the assignments.

### Printers

Show compatible printers first. Explain why an incompatible printer is unavailable. A plate assignment should remain after navigation, filtering, automatic filling, and page reload.

When several plates share the same requirements, let the operator assign one printer to the selection. **Fill by source** should be a batch rule that writes assignments to plates. It should not depend on whichever dropdown is currently focused.

### Review & send

Show one summary row per plate. Each row needs the plate name, source groups, assigned printer, file or slice state, warnings, and next action. Put unresolved plates first. Allow **Export all ready plates** and **Queue all ready plates**, but keep per-plate actions available.

After handoff, move operational status to All Production. Build Production prepares and dispatches the work. All Production owns live printer state, the queue, and history. Keeping those scopes separate follows the slicer and print-server split between project preparation and printer operations.

## Priority

1. Make plate-to-printer assignment durable and make **Fill by source** read and write the same state.
2. Add grouping, collapse, search, unresolved-only filtering, and compact repeated-unit counts.
3. Divide Build Production into the four stages without changing the underlying route.
4. Add plate-level bulk assignment and handoff actions.
5. Keep live jobs, the global queue, and history in All Production.

## Research limits

The sources document product behavior, not a controlled comparison of operator speed. The PrintPartner recommendations are design inferences from repeated first-party patterns across slicers and print servers. They need validation with a real large Build and the operators who dispatch it.
