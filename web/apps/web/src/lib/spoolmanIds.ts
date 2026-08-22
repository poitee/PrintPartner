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
