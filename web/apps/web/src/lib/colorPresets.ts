import { saveRoleFilament, type RoleFilamentRow } from "../api/engine";

export const COLOR_PRESET_TYPE = "print-partner-colors";
export const COLOR_PRESET_VERSION = 1;

export type ColorPresetRole = {
  role: string;
  filament_color_id: string | null;
  filament_custom_hex: string | null;
  spoolman_spool_id: string | null;
};

export type ColorPreset = {
  type: typeof COLOR_PRESET_TYPE;
  version: number;
  exported_at: string;
  roles: ColorPresetRole[];
};

/** Build a portable color preset from the current role filament rows. */
export function buildColorPreset(rows: RoleFilamentRow[]): ColorPreset {
  return {
    type: COLOR_PRESET_TYPE,
    version: COLOR_PRESET_VERSION,
    exported_at: new Date().toISOString(),
    roles: rows.map((row) => ({
      role: row.role,
      filament_color_id: row.filament_color_id ?? null,
      filament_custom_hex: row.filament_custom_hex ?? null,
      spoolman_spool_id: row.spoolman_spool_id ?? null,
    })),
  };
}

/** Trigger a browser download of a color preset as a JSON file. */
export function downloadColorPreset(rows: RoleFilamentRow[], filename = "print-partner-colors.json"): void {
  if (typeof document === "undefined") return;
  const preset = buildColorPreset(rows);
  const blob = new Blob([JSON.stringify(preset, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Open a file picker for a color preset JSON file. Resolves null if cancelled. */
export function pickColorPresetFile(): Promise<File | null> {
  if (typeof document === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = () => {
      resolve(input.files?.[0] ?? null);
    };
    // Some browsers need the input in the DOM for the dialog to open reliably.
    input.style.display = "none";
    document.body.appendChild(input);
    input.click();
    // Clean up after the dialog round-trips.
    setTimeout(() => input.remove(), 0);
  });
}

/** Parse and validate a color preset file. Throws on malformed input. */
export async function parseColorPreset(file: File): Promise<ColorPreset> {
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error("Not a valid JSON file.");
  }
  if (!data || typeof data !== "object") {
    throw new Error("Color file is empty or malformed.");
  }
  const preset = data as Partial<ColorPreset>;
  if (preset.type !== COLOR_PRESET_TYPE || !Array.isArray(preset.roles)) {
    throw new Error("This file is not a Print Partner colors export.");
  }
  const roles: ColorPresetRole[] = preset.roles
    .filter((r): r is ColorPresetRole => !!r && typeof (r as ColorPresetRole).role === "string")
    .map((r) => ({
      role: r.role,
      filament_color_id: r.filament_color_id ?? null,
      filament_custom_hex: r.filament_custom_hex ?? null,
      spoolman_spool_id: r.spoolman_spool_id ?? null,
    }));
  if (roles.length === 0) {
    throw new Error("No role colors found in the file.");
  }
  return {
    type: COLOR_PRESET_TYPE,
    version: typeof preset.version === "number" ? preset.version : COLOR_PRESET_VERSION,
    exported_at: typeof preset.exported_at === "string" ? preset.exported_at : new Date().toISOString(),
    roles,
  };
}

/**
 * Apply a color preset to a plan by saving each role's filament assignment.
 * Returns the number of roles applied. A catalog color id takes precedence over
 * a custom hex, mirroring how the role picker stores colors.
 */
export async function applyColorPreset(profileId: number, preset: ColorPreset): Promise<number> {
  let applied = 0;
  for (const role of preset.roles) {
    await saveRoleFilament(profileId, {
      role: role.role,
      filament_color_id: role.filament_color_id ?? null,
      filament_custom_hex: role.filament_color_id ? null : role.filament_custom_hex ?? null,
      spoolman_spool_id: role.spoolman_spool_id ?? null,
      refresh_thumbnails: false,
    });
    applied += 1;
  }
  return applied;
}
