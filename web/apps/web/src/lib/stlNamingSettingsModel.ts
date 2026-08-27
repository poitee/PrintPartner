import type { StlNamingRoleId } from "@print-partner/contracts";

export const STL_NAMING_ROLE_LABELS: Record<StlNamingRoleId, string> = {
  primary: "Primary",
  accent: "Accent",
  clear: "Clear",
  opaque: "Opaque",
};

export function markersToInput(markers: readonly string[]): string {
  return markers.join(", ");
}

export function parseMarkersInput(value: string): string[] {
  return value
    .split(",")
    .map((marker) => marker.trim())
    .filter(Boolean);
}

export function isEngineNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("404");
}
