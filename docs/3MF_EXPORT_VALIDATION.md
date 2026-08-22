# Accepted Plate 3MF validation

Print Partner writes deterministic 3MF Core packages from one immutable
accepted Plate revision. The files are slicer input, not full PrusaSlicer,
OrcaSlicer, or Bambu Studio project files.

## What to expect

| Concern | Behavior |
|---------|----------|
| **Identity** | Every model object uses the accepted Required-unit Object name as `name`. Its `partnumber` and the build item's `partnumber` are the Required-unit token. |
| **Geometry** | The exported mesh comes from the accepted artifact descriptor and digest. Its serialized minimum X, Y, and Z match the saved Plate position. Print Partner does not rotate or scale the mesh. |
| **Printer** | Each Plate carries the Printer ID, name, model, bed size, and margin captured when that Plate revision was published. Export does not choose or reroute a Printer. |
| **Files** | A revision-keyed tree contains `manifest.json`, `bundle.zip`, and one `plates/NNNN.3mf` file per saved Plate in ordinal order. |
| **Not included** | Slicer machine, process, or filament profiles; G-code; automatic orientation; vendor project metadata. Choose those in the slicer. |

## Setup

1. Apply a Plan so its Required-unit set is accepted.
2. On Export, assign every Required unit to a Printer. Source-layer and role
   group fills can apply the same Printer to several units.
3. Initialize Plates. Print Partner packs the accepted artifact footprints
   without rotation and publishes an immutable Plate revision.
4. Move units by dragging or by entering exact millimetre coordinates. Each
   successful move publishes a successor Plate revision.
5. Download the accepted 3MF bundle or open the same revision in a configured
   local slicer.

## Manual checklist

1. Record the Plate revision shown on Export.
2. Download the bundle and extract `manifest.json` and `plates/NNNN.3mf`.
3. Open each Plate in PrusaSlicer, OrcaSlicer, or Bambu Studio.
4. Confirm every expected mesh appears once and retains its Source orientation.
5. Compare the slicer's object names with the manifest `object_name` values.
6. Confirm Plate placement matches the saved Export layout.
7. Choose machine, filament, and process profiles in the slicer, then slice.

## Automated coverage

- `web/packages/domain/src/accepted-plate-packer.test.ts` verifies deterministic
  no-rotation packing and integer positions.
- `web/packages/domain/src/accepted-plate-3mf.test.ts` verifies deterministic ZIP
  structure, Required-unit identity, exact placement, and output limits.
- `web/apps/server/src/services/accepted-plate-3mf.test.ts` verifies accepted
  artifact resolution, digest checks, revision matching, and real repository
  generation.
- `web/apps/server/src/services/accepted-plate-export-delivery.test.ts` verifies
  revision-keyed publication, retry verification, concurrent publication, and
  tamper rejection.
- `web/apps/server/src/routes/accepted-plate-export-delivery-routes.test.ts`
  verifies accepted job, download, handoff, tenant isolation, and redacted
  failures.
