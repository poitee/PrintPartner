import type { AppRepository } from "../db/repository.js";
import { DEFAULT_NAMING_PROFILE } from "@print-partner/domain";

export type RoleFilamentDefault = {
  filament_color_id: string | null;
  filament_custom_hex: string | null;
  spoolman_spool_id: string | null;
};

export type RoleFilamentDefaults = Record<string, RoleFilamentDefault>;

const EMPTY_DEFAULT: RoleFilamentDefault = {
  filament_color_id: null,
  filament_custom_hex: null,
  spoolman_spool_id: null,
};

export function roleFilamentSettingKey(profileId: number): string {
  return `role_filaments_${profileId}`;
}

export function loadRoleFilamentDefaults(
  repo: AppRepository,
  profileId: number,
): RoleFilamentDefaults {
  const raw = repo.getSetting(roleFilamentSettingKey(profileId));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: RoleFilamentDefaults = {};
    for (const [role, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const row = value as Record<string, unknown>;
      out[role] = {
        filament_color_id:
          typeof row.filament_color_id === "string" ? row.filament_color_id : null,
        filament_custom_hex:
          typeof row.filament_custom_hex === "string" ? row.filament_custom_hex : null,
        spoolman_spool_id:
          typeof row.spoolman_spool_id === "string" ? row.spoolman_spool_id : null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveRoleFilamentDefault(
  repo: AppRepository,
  profileId: number,
  role: string,
  patch: Partial<RoleFilamentDefault>,
): RoleFilamentDefault {
  const merged = {
    ...EMPTY_DEFAULT,
    ...loadRoleFilamentDefaults(repo, profileId)[role],
    ...patch,
  };
  const all = loadRoleFilamentDefaults(repo, profileId);
  all[role] = merged;
  repo.setSetting(roleFilamentSettingKey(profileId), JSON.stringify(all));
  return merged;
}

export function canonicalRoleOrder(): string[] {
  return [...DEFAULT_NAMING_PROFILE.export_role_order];
}
