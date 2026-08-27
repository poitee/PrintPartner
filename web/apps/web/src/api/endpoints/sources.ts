import type { SourceSummary } from "@print-partner/contracts";
import { mergeSourceMetadataCategory } from "../../lib/sourceMetadata";
import { engineFetch } from "../engineTransport";

export type StlSearchHit = {
  source_id: number;
  source_name: string;
  category: string | null;
  relative_path: string;
  filename: string;
};

export type StlSearchResponse = {
  query: string;
  results: StlSearchHit[];
};

export type SaveSourceCategoriesInput = {
  categories: string[];
  replacements?: Record<string, string | null>;
};

export type CreateSourceInput = {
  name: string;
  url?: string;
  branch?: string;
  tag?: string | null;
  source_kind: string;
  role?: string;
  category?: string | null;
  local_path?: string;
  metadata?: Record<string, unknown>;
};

export type UpdateSourceInput = Partial<{
  name: string;
  url: string;
  branch: string;
  tag: string | null;
  source_kind: string;
  role: string;
  category: string | null;
  local_path: string;
  metadata: Record<string, unknown>;
}>;

export type BulkCategoryAssignResult = {
  updated: SourceSummary[];
  results: Array<{ source_id: number; ok: boolean; detail?: string }>;
  succeeded: number;
  failed: number;
};

export type StlTreeFileNode = {
  kind: "file";
  path: string;
  name: string;
  checked: boolean;
};

export type StlTreeFolderNode = {
  kind: "folder";
  path: string;
  name: string;
  check_state: "checked" | "unchecked" | "partial";
  children: StlTreeNode[];
};

export type StlTreeNode = StlTreeFileNode | StlTreeFolderNode;

export type StlTreeResponse = {
  project_id: number;
  legacy_import_all: boolean;
  total: number;
  selected: number;
  nodes: StlTreeNode[];
};

export async function fetchSources(): Promise<SourceSummary[]> {
  const body = await engineFetch<{ sources: SourceSummary[] }>("/sources");
  return body.sources;
}

export async function fetchSourceHasManifest(
  sourceId: number,
): Promise<{ has_manifest: boolean; manifest_kind: string | null }> {
  return engineFetch(`/sources/${sourceId}/has-manifest`);
}

export async function fetchSourceCategories(): Promise<string[]> {
  const body = await engineFetch<{ categories: string[] }>("/settings/source-categories");
  return body.categories;
}

export async function saveSourceCategories(input: SaveSourceCategoriesInput): Promise<string[]> {
  const body = await engineFetch<{ categories: string[] }>("/settings/source-categories", {
    method: "PUT",
    body: JSON.stringify(input),
  });
  return body.categories;
}

export async function searchSourceStls(q: string, limit = 50): Promise<StlSearchResponse> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  return engineFetch<StlSearchResponse>(`/sources/stl-search?${params}`);
}

export async function createSource(body: CreateSourceInput): Promise<SourceSummary> {
  const { category, metadata, ...rest } = body;
  const payload = {
    ...rest,
    metadata: mergeSourceMetadataCategory(metadata, category),
  };
  return engineFetch<SourceSummary>("/sources", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateSource(sourceId: number, fields: UpdateSourceInput): Promise<SourceSummary> {
  const { category, metadata, ...rest } = fields;
  const payload = {
    ...rest,
    ...(category !== undefined
      ? { metadata: mergeSourceMetadataCategory(metadata, category) }
      : metadata !== undefined
        ? { metadata }
        : {}),
  };
  return engineFetch<SourceSummary>(`/sources/${sourceId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

/** Assign one category (or null for Uncategorised) to many sources at once. */
export async function bulkAssignSourceCategory(
  sourceIds: number[],
  category: string | null,
): Promise<BulkCategoryAssignResult> {
  return engineFetch<BulkCategoryAssignResult>("/sources/bulk-category", {
    method: "POST",
    body: JSON.stringify({ source_ids: sourceIds, category }),
  });
}

export async function deleteSource(sourceId: number): Promise<void> {
  await engineFetch(`/sources/${sourceId}`, { method: "DELETE" });
}

export async function fetchImportRules(sourceId: number): Promise<{
  rules: string[];
  legacy_import_all: boolean;
}> {
  return engineFetch(`/sources/${sourceId}/import-rules`);
}

export async function saveImportRules(sourceId: number, rules: string[]): Promise<{ rules: string[] }> {
  return engineFetch(`/sources/${sourceId}/import-rules`, {
    method: "PUT",
    body: JSON.stringify({ rules }),
  });
}

export async function fetchStlTree(sourceId: number): Promise<StlTreeResponse> {
  return engineFetch(`/sources/${sourceId}/stl-tree`);
}

export async function startImportScan(projectId: number): Promise<string> {
  const body = await engineFetch<{ job_id: string }>("/jobs/import-scan", {
    method: "POST",
    body: JSON.stringify({ project_id: projectId }),
  });
  return body.job_id;
}
