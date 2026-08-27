import type { PartRow, ProfileSummary } from "@print-partner/contracts";
import { engineFetch } from "../engineTransport";

export type ProfileLayer = {
  id: number;
  layer_order: number;
  layer_type: string;
  project_id: number | null;
  project_name: string | null;
};

export type PartsGroup = {
  folder: string;
  parts: PartRow[];
};

export async function fetchProfiles(): Promise<ProfileSummary[]> {
  const body = await engineFetch<{ profiles: ProfileSummary[] }>("/plans");
  return body.profiles;
}

export async function createProfile(
  name: string,
  baseProjectId?: number,
): Promise<ProfileSummary & { layers?: ProfileLayer[] }> {
  return engineFetch("/plans", {
    method: "POST",
    body: JSON.stringify({
      name,
      ...(baseProjectId != null ? { base_project_id: baseProjectId } : {}),
    }),
  });
}

export async function updateProfile(
  profileId: number,
  patch: { name?: string; special_request?: string | null },
): Promise<ProfileSummary> {
  return engineFetch(`/plans/${profileId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function archiveProfile(profileId: number): Promise<ProfileSummary> {
  return engineFetch(`/plans/${profileId}/archive`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function touchProfileLastUsed(profileId: number): Promise<ProfileSummary> {
  return engineFetch(`/plans/${profileId}/touch`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function deleteProfile(profileId: number): Promise<void> {
  await engineFetch(`/plans/${profileId}`, { method: "DELETE" });
}

export async function duplicateProfile(
  profileId: number,
  name: string,
  options?: { clearCheckoff?: boolean },
): Promise<ProfileSummary & { layers?: ProfileLayer[] }> {
  return engineFetch(`/plans/${profileId}/duplicate`, {
    method: "POST",
    body: JSON.stringify({ name, clear_checkoff: options?.clearCheckoff ?? false }),
  });
}

export async function setProfileBaseLayer(
  profileId: number,
  projectId: number,
): Promise<ProfileLayer[]> {
  const body = await engineFetch<{ layers: ProfileLayer[] }>(`/plans/${profileId}/layers/base`, {
    method: "PUT",
    body: JSON.stringify({ project_id: projectId }),
  });
  return body.layers;
}

export async function deleteProfileLayer(profileId: number, layerId: number): Promise<void> {
  await engineFetch(`/plans/${profileId}/layers/${layerId}`, {
    method: "DELETE",
  });
}

export async function fetchProfilePartsGrouped(
  profileId: number,
  query = "",
): Promise<{ groups: PartsGroup[]; total: number }> {
  const q = query.trim() ? `?query=${encodeURIComponent(query.trim())}` : "";
  return engineFetch<{ groups: PartsGroup[]; total: number }>(`/plans/${profileId}/parts-grouped${q}`);
}

export async function replaceProfileLayer(
  profileId: number,
  layerId: number,
  projectId: number,
): Promise<ProfileLayer[]> {
  const body = await engineFetch<{ layers: ProfileLayer[] }>(`/plans/${profileId}/layers/${layerId}`, {
    method: "PUT",
    body: JSON.stringify({ project_id: projectId }),
  });
  return body.layers;
}

export async function fetchProfileLayers(profileId: number): Promise<ProfileLayer[]> {
  const body = await engineFetch<{ layers: ProfileLayer[] }>(`/plans/${profileId}/layers`);
  return body.layers;
}

export async function addProfileAddonLayer(
  profileId: number,
  projectId: number,
): Promise<ProfileLayer[]> {
  const body = await engineFetch<{ layers: ProfileLayer[] }>(`/plans/${profileId}/layers`, {
    method: "POST",
    body: JSON.stringify({ project_id: projectId }),
  });
  return body.layers;
}

export async function patchPart(
  partId: number,
  fields: {
    filament_color_id?: string;
    spoolman_spool_id?: string | null;
  },
): Promise<PartRow> {
  return engineFetch<PartRow>(`/parts/${partId}`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  });
}
