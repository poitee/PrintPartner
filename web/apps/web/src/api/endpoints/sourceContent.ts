import { engineFetch, engineFetchStream } from "../engineTransport";

export type SourceUpdateCheckSettings = {
  interval_hours: number;
  auto_sync_updates: boolean;
  last_checked_at: string | null;
};

export type SourceActivityEvent = {
  id: number;
  at: string;
  kind: "source.update_available" | "source.updated" | "source.sync_failed";
  source_id: number | null;
  source_name: string;
  detail: string | null;
};

export type GithubBranchesResponse = {
  owner: string;
  repo: string;
  default_branch: string;
  branches: string[];
};

export type GithubTagsResponse = {
  owner: string;
  repo: string;
  tags: string[];
};

export type GitHubPatSettings = {
  configured: boolean;
  masked: string | null;
};

export type SourceDocSummary = {
  path: string;
  title: string;
  kind?: string;
  extract_status?: string;
};

export type SourceNote = {
  id: number;
  project_id: number;
  profile_id: number | null;
  title: string;
  body_markdown: string;
  author_user_id: string | null;
  created_at: string;
  updated_at: string;
};

async function fetchGithubRefList<T>(url: string, path: string, label: string): Promise<T> {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error("GitHub repository URL is required");
  }
  const query = new URLSearchParams({ url: trimmed });
  const response = await engineFetchStream({
    path: `${path}?${query.toString()}`,
    failureMessage: `Could not list ${label}`,
  });
  return response.json();
}

export async function fetchGithubBranches(url: string): Promise<GithubBranchesResponse> {
  return fetchGithubRefList(url, "/sources/github-branches", "branches");
}

export async function fetchGithubTags(url: string): Promise<GithubTagsResponse> {
  return fetchGithubRefList(url, "/sources/github-tags", "tags");
}

export async function fetchGitHubPatSettings(): Promise<GitHubPatSettings> {
  return engineFetch<GitHubPatSettings>("/settings/github-pat");
}

export async function saveGitHubPat(token: string): Promise<GitHubPatSettings> {
  return engineFetch<GitHubPatSettings>("/settings/github-pat", {
    method: "PUT",
    body: JSON.stringify({ token }),
  });
}

export async function fetchSourceUpdateCheckSettings(): Promise<SourceUpdateCheckSettings> {
  return engineFetch<SourceUpdateCheckSettings>("/settings/source-update-check");
}

export async function saveSourceUpdateCheckInterval(
  intervalHours: number,
): Promise<SourceUpdateCheckSettings> {
  return saveSourceMonitoringSettings({ interval_hours: intervalHours });
}

export async function saveSourceMonitoringSettings(
  settings: Partial<Pick<SourceUpdateCheckSettings, "interval_hours" | "auto_sync_updates">>,
): Promise<SourceUpdateCheckSettings> {
  return engineFetch<SourceUpdateCheckSettings>("/settings/source-update-check", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function fetchSourceActivity(limit = 20): Promise<SourceActivityEvent[]> {
  const query = new URLSearchParams({ limit: String(limit) });
  const body = await engineFetch<{ events: SourceActivityEvent[] }>(
    `/sources/activity?${query.toString()}`,
  );
  return body.events;
}

export async function startCheckSourceUpdates(): Promise<string> {
  const body = await engineFetch<{ job_id: string }>("/jobs/check-source-updates", {
    method: "POST",
    body: JSON.stringify({}),
  });
  return body.job_id;
}

export async function fetchSourceDocs(sourceId: number): Promise<SourceDocSummary[]> {
  const body = await engineFetch<{ docs: SourceDocSummary[] }>(`/sources/${sourceId}/docs`);
  return body.docs;
}

export async function fetchSourceDocMarkdown(sourceId: number, docPath: string): Promise<string> {
  const body = await engineFetch<{ markdown: string }>(`/sources/${sourceId}/docs/${docPath}`);
  return body.markdown;
}

export async function fetchSourceReadme(
  sourceId: number,
  live = false,
): Promise<{ markdown: string; source: string; cached: boolean }> {
  return engineFetch(`/sources/${sourceId}/readme${live ? "?live=1" : ""}`);
}

export async function fetchSourceNotes(sourceId: number, profileId?: number | null): Promise<SourceNote[]> {
  const q = profileId != null && profileId > 0 ? `?profile_id=${profileId}` : "";
  const body = await engineFetch<{ notes: SourceNote[] }>(`/sources/${sourceId}/notes${q}`);
  return body.notes;
}

export async function createSourceNote(
  sourceId: number,
  input: { title?: string; body_markdown: string; profile_id?: number | null },
): Promise<SourceNote> {
  return engineFetch(`/sources/${sourceId}/notes`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateSourceNote(
  sourceId: number,
  noteId: number,
  input: { title?: string; body_markdown?: string; profile_id?: number | null },
): Promise<SourceNote> {
  return engineFetch(`/sources/${sourceId}/notes/${noteId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteSourceNote(sourceId: number, noteId: number): Promise<void> {
  await engineFetch(`/sources/${sourceId}/notes/${noteId}`, { method: "DELETE" });
}
