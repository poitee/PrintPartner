import {
  resolveFilamentAssignment,
  type FilamentAssignment,
} from "../db/accepted-part-filament.js";

export type CompleteRoleAssignmentInput = {
  filament_color_id?: string | null;
  filament_custom_hex?: string | null;
  spoolman_spool_id?: string | null;
};

export function completeRoleAssignment(body: CompleteRoleAssignmentInput): FilamentAssignment {
  return resolveFilamentAssignment(
    { color: { kind: "unset" }, spoolmanSpoolId: null },
    {
      colorId: body.filament_color_id ?? null,
      customHex: body.filament_custom_hex ?? null,
      spoolmanSpoolId: body.spoolman_spool_id ?? null,
    },
  );
}
