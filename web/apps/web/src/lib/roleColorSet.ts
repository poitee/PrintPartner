/** A role color counts as set when catalog id or custom hex is present. */
export function roleColorIsSet(row: {
  filament_color_id?: string | null;
  filament_custom_hex?: string | null;
}): boolean {
  return Boolean(row.filament_color_id?.trim() || row.filament_custom_hex?.trim());
}

/**
 * True when any role that has parts still has no color.
 * Custom hex counts as set — do not force catalog filaments.
 */
export function planHasUnsetRoleColors(
  rows: ReadonlyArray<{
    part_count: number;
    filament_color_id?: string | null;
    filament_custom_hex?: string | null;
  }>,
): boolean {
  return rows.some((r) => r.part_count > 0 && !roleColorIsSet(r));
}
