const ROLE_MESH_RGB: Record<string, string> = {
  primary: "#4a90d9",
  accent: "#e67e22",
  clear: "#a8d8ea",
  opaque: "#7f8c8d",
};

export function normalizeMeshHex(hexColor: string | null | undefined): string | null {
  if (!hexColor) return null;
  const h = hexColor.trim().replace(/^#/, "").toLowerCase();
  if (h.length !== 6 || !/^[0-9a-f]+$/.test(h)) return null;
  return `#${h}`;
}

export function resolveMeshColor(role: string, filamentHex?: string | null): string {
  const normalized = normalizeMeshHex(filamentHex ?? null);
  if (normalized) return normalized;
  return ROLE_MESH_RGB[role] ?? ROLE_MESH_RGB.primary;
}
