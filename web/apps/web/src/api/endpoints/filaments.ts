import { engineFetch } from "../engineTransport";

export type CatalogColor = {
  id: string;
  display_name: string;
  product_line: string;
  hex: string;
  combo_label: string;
  swatch_url: string;
};

export type FilamentCatalog = {
  synced_at: string;
  source: string;
  status: string;
  colors: CatalogColor[];
  custom_colors: CatalogColor[];
  spoolman_colors?: CatalogColor[];
  /** Set when a Spoolman integration is selected for the Build picker. */
  default_spoolman_integration_id?: string | null;
  spoolman_status?: "ok" | "empty" | "error" | "disabled" | "not_found";
  spoolman_error?: string | null;
};

export type RoleFilamentRow = {
  role: string;
  part_count: number;
  filament_color_id: string | null;
  spoolman_spool_id?: string | null;
  filament_custom_hex: string | null;
  filament_display: string;
  filament_hex: string | null;
};

export type SpoolmanSpoolRow = {
  id: number;
  filament_id: number;
  remaining_weight: number | null;
  location?: string | null;
};

export type CustomFilament = {
  id: string;
  color_id: string;
  display_name: string;
  hex: string;
  product_line: string;
  notes: string;
  created_at: string;
};

export type SpoolmanDefaultSettings = {
  integration_id: string | null;
};

export type SaveRoleFilamentPayload = {
  role: string;
  filament_color_id?: string | null;
  filament_custom_hex?: string | null;
  spoolman_spool_id?: string | null;
  /** When true (default), clear cached thumbnails for parts in this role after apply. */
  refresh_thumbnails?: boolean;
};

export type RoleFilamentMutationResult = {
  updated: number;
  thumbnails_cleared: number;
  roles: RoleFilamentRow[];
};

export async function fetchCustomFilaments(): Promise<CustomFilament[]> {
  const body = await engineFetch<{ filaments: CustomFilament[] }>("/filaments/custom");
  return body.filaments;
}

export async function fetchSpoolmanDefaultSettings(): Promise<SpoolmanDefaultSettings> {
  return engineFetch<SpoolmanDefaultSettings>("/settings/spoolman-default");
}

export async function saveSpoolmanDefaultIntegration(
  integrationId: string | null,
): Promise<SpoolmanDefaultSettings> {
  return engineFetch<SpoolmanDefaultSettings>("/settings/spoolman-default", {
    method: "PUT",
    body: JSON.stringify({ integration_id: integrationId }),
  });
}

export async function fetchFilamentCatalog(): Promise<FilamentCatalog> {
  return engineFetch<FilamentCatalog>("/filaments/catalog");
}

export async function createCustomFilament(body: {
  display_name: string;
  hex: string;
  product_line?: string;
}): Promise<CustomFilament> {
  return engineFetch<CustomFilament>("/filaments/custom", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function deleteCustomFilament(filamentId: string): Promise<void> {
  await engineFetch(`/filaments/custom/${encodeURIComponent(filamentId)}`, {
    method: "DELETE",
  });
}

export async function fetchRoleFilaments(profileId: number): Promise<RoleFilamentRow[]> {
  const body = await engineFetch<{ roles: RoleFilamentRow[] }>(`/plans/${profileId}/role-filaments`);
  return body.roles;
}

export async function saveRoleFilament(
  profileId: number,
  payload: SaveRoleFilamentPayload,
): Promise<RoleFilamentMutationResult> {
  return engineFetch(`/plans/${profileId}/role-filament`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

/** Re-apply every saved role color to matching parts and refresh thumbnails/checkoff data. */
export async function applyRoleColorsToParts(
  profileId: number,
  options?: { refresh_thumbnails?: boolean },
): Promise<RoleFilamentMutationResult> {
  return engineFetch(`/plans/${profileId}/apply-role-colors`, {
    method: "POST",
    body: JSON.stringify(options ?? {}),
  });
}

export async function fetchSpoolmanSpools(integrationId: string): Promise<SpoolmanSpoolRow[]> {
  const body = await engineFetch<{ spools: SpoolmanSpoolRow[] }>(
    `/api/v1/integrations/${encodeURIComponent(integrationId)}/spoolman/spools`,
  );
  return body.spools;
}
