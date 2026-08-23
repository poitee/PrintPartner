type AcceptedPlateColorFields = Readonly<{
  filament_hex?: string | null;
  filament_custom_hex?: string | null;
  filament_color_id?: string | null;
}>;

function normalizeHex(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return undefined;
  const candidate = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(candidate)) return undefined;
  return `#${candidate}`;
}

/** Resolve the display color carried by an accepted Plate unit. */
export function acceptedPlateUnitColor(unit: AcceptedPlateColorFields): string | undefined {
  return normalizeHex(unit.filament_hex)
    ?? normalizeHex(unit.filament_custom_hex)
    ?? normalizeHex(unit.filament_color_id);
}
