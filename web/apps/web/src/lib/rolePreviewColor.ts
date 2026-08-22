import type { RoleFilamentRow, StlNamingProfile } from "../api/engine";

type PartRole = "primary" | "accent" | "clear" | "opaque";

function roleFromId(roleId: string): PartRole {
  if (roleId === "accent" || roleId === "clear" || roleId === "opaque") return roleId;
  return "primary";
}

function checkRoleInText(text: string, profile: StlNamingProfile): PartRole | null {
  const lower = text.toLowerCase();
  for (const role of profile.roles) {
    for (const marker of role.markers) {
      if (marker && lower.includes(marker.toLowerCase())) return roleFromId(role.id);
    }
  }
  return null;
}

function folderRole(relativePath: string, profile: StlNamingProfile): PartRole | null {
  const posix = relativePath.replace(/\\/g, "/").toLowerCase();
  for (const rule of profile.folder_rules) {
    if (posix.includes(rule.path_contains.toLowerCase())) {
      return roleFromId(rule.role_id);
    }
  }
  return null;
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function parentParts(path: string): string[] {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  parts.pop();
  return parts;
}

/** Match server-side STL role parsing for live build previews. */
export function parseStlRole(relativePath: string, profile: StlNamingProfile): PartRole {
  const foundFolder = folderRole(relativePath, profile);
  if (foundFolder) return foundFolder;
  const segments = [...parentParts(relativePath), basename(relativePath)];
  for (const segment of segments) {
    const found = checkRoleInText(segment, profile);
    if (found) return found;
  }
  return "primary";
}

/** Resolve the preview mesh color for a source STL from role filament defaults. */
export function meshColorForStlPath(
  relativePath: string,
  namingProfile: StlNamingProfile,
  roleFilaments: readonly RoleFilamentRow[],
): string | undefined {
  const role = parseStlRole(relativePath, namingProfile);
  const row = roleFilaments.find((r) => r.role === role);
  return row?.filament_hex ?? undefined;
}
