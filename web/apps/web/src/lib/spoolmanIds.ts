export function hasSpoolmanAssignment(assignment: {
  filament_color_id?: string | null;
  spoolman_spool_id?: string | null;
}): boolean {
  return Boolean(assignment.filament_color_id?.trim().startsWith("spoolman:") || assignment.spoolman_spool_id?.trim());
}

export function hasSpoolmanColorOrigin(assignment: Parameters<typeof hasSpoolmanAssignment>[0]): boolean {
  return hasSpoolmanAssignment({ filament_color_id: assignment.filament_color_id })
    || (!assignment.filament_color_id?.trim() && hasSpoolmanAssignment(assignment));
}

export function parseSpoolmanFilamentId(
  colorId: string,
): { integrationId: string; filamentId: number } | null {
  const m = /^spoolman:([^:]+):filament:(\d+)$/.exec(colorId.trim());
  if (!m) return null;
  return { integrationId: m[1]!, filamentId: Number(m[2]) };
}

export function buildSpoolmanSpoolId(integrationId: string, spoolId: number): string {
  return `spoolman:${integrationId}:spool:${spoolId}`;
}

export function parseSpoolmanSpoolId(
  spoolRef: string,
): { integrationId: string; spoolId: number } | null {
  const m = /^spoolman:([^:]+):spool:(\d+)$/.exec(spoolRef.trim());
  if (!m) return null;
  return { integrationId: m[1]!, spoolId: Number(m[2]) };
}
