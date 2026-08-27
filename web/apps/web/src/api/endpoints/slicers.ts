import { engineFetch } from "../engineTransport";

export type SlicerProfileOptions = {
  printers: Array<{ id: number; name: string; last_synced_at: string | null }>;
  filaments: Array<{
    id: number;
    name: string;
    material_type: string | null;
    last_synced_at: string | null;
  }>;
  processes: Array<{ id: number; name: string; last_synced_at: string | null }>;
};

export type SlicerInstanceKind = "orca" | "prusa" | "bambu" | "custom";
export type SlicerDialect = "orca_json" | "bambu_json" | "prusa_ini";

export type SlicerInstance = {
  id: string;
  name: string;
  kind: SlicerInstanceKind | string;
  dialect: SlicerDialect | string;
  gui_url: string;
  watch_path: string;
  docker_target: string;
  docker_host: string | null;
  compose_service: string | null;
  image: string | null;
  container_name: string | null;
  status_cache: string;
  status_message: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type SlicerInstanceWrite = {
  name: string;
  kind: SlicerInstanceKind;
  dialect?: SlicerDialect;
  gui_url?: string;
  watch_path?: string;
  enabled?: boolean;
};

export type SlicerDockerStatusResponse = {
  instance: SlicerInstance;
  status: {
    state: string;
    message: string | null;
    container_id: string | null;
  };
};

export async function fetchSlicerProfileOptions(): Promise<SlicerProfileOptions> {
  return engineFetch<SlicerProfileOptions>("/slicer-profile-options");
}

export async function fetchSlicerInstances(): Promise<SlicerInstance[]> {
  const body = await engineFetch<{ instances: SlicerInstance[] }>("/slicer-instances");
  return body.instances;
}

export async function createSlicerInstance(body: SlicerInstanceWrite): Promise<SlicerInstance> {
  return engineFetch<SlicerInstance>("/slicer-instances", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function updateSlicerInstance(
  id: string,
  body: Partial<SlicerInstanceWrite>,
): Promise<SlicerInstance> {
  return engineFetch<SlicerInstance>(`/slicer-instances/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function deleteSlicerInstance(id: string): Promise<void> {
  await engineFetch(`/slicer-instances/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function seedDefaultSlicerInstances(): Promise<{
  inserted: number;
  instances: SlicerInstance[];
}> {
  return engineFetch("/slicer-instances/seed-defaults", { method: "POST" });
}

export async function fetchSlicerDockerStatus(id: string): Promise<SlicerDockerStatusResponse> {
  return engineFetch(`/slicer-instances/${encodeURIComponent(id)}/docker-status`);
}

export async function pullSlicerDocker(id: string): Promise<SlicerDockerStatusResponse> {
  return engineFetch(`/slicer-instances/${encodeURIComponent(id)}/docker-pull`, {
    method: "POST",
  });
}

export async function startSlicerDocker(id: string): Promise<SlicerDockerStatusResponse> {
  return engineFetch(`/slicer-instances/${encodeURIComponent(id)}/docker-start`, {
    method: "POST",
  });
}

export async function stopSlicerDocker(id: string): Promise<SlicerDockerStatusResponse> {
  return engineFetch(`/slicer-instances/${encodeURIComponent(id)}/docker-stop`, {
    method: "POST",
  });
}

export async function fetchSlicerDockerLogs(id: string, tail = 200): Promise<{ lines: string[] }> {
  return engineFetch(
    `/slicer-instances/${encodeURIComponent(id)}/docker-logs?tail=${encodeURIComponent(String(tail))}`,
  );
}
