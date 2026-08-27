import {
  DEFAULT_STL_NAMING_PROFILE,
  type StlNamingRoleId,
} from "@print-partner/contracts";

export const DEFAULT_ROLE_LABELS = Object.fromEntries(
  DEFAULT_STL_NAMING_PROFILE.roles.map((role) => [role.id, role.label]),
) as Record<StlNamingRoleId, string>;

export function roleFilamentLabel(roleId: string): string {
  return DEFAULT_ROLE_LABELS[roleId as StlNamingRoleId] ?? roleId;
}

export function normalizeFilamentHex(hex: string): string | null {
  const value = hex.trim().replace(/^#?/, "");
  if (/^[0-9a-fA-F]{6}$/.test(value)) return `#${value.toLowerCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(value)) {
    return `#${value
      .split("")
      .map((character) => character + character)
      .join("")
      .toLowerCase()}`;
  }
  return null;
}
