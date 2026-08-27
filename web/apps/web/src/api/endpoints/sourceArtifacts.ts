import type { SourceSummary } from "@print-partner/contracts";
import { engineFetch, engineFetchMultipart } from "../engineTransport";

type ChoiceTreeNode = {
  id: string;
  label?: string;
  type?: "pick_one" | "pick_any" | "addon_toggle";
  group?: string;
  source_id?: string;
  replaces_slot?: string;
  sources?: string[];
  children?: ChoiceTreeNode[];
};

export type RepoManifestPartRule = {
  match: string;
  requirement?: string;
  change?: string;
  replaces?: string;
  replaces_slot?: string;
  default_included?: boolean;
  option_group?: string;
  slot?: string;
};

export type RepoManifestSlot = {
  label?: string;
  default_group?: string;
};

export type RepoManifestVariantSource = {
  source_id: number;
  source_name: string;
};

export type RepoManifestVariant = {
  id: string;
  label?: string;
  parts?: string[];
  excludes?: string[];
  source_id?: number;
  source_name?: string;
  sources?: RepoManifestVariantSource[];
};

export type RepoManifestOptionGroup = {
  rule: string;
  label?: string;
  parts?: Array<{ match: string } | string>;
  variants?: RepoManifestVariant[];
  min?: number;
  max?: number;
};

export type RepoManifestDocument = {
  format?: string;
  version?: number;
  project?: string;
  plan?: {
    name?: string;
    base_source_id?: string;
    addon_source_ids?: string[];
  };
  sources?: Array<{
    id: string;
    kind: string;
    url?: string;
    branch?: string;
    role?: string;
  }>;
  selections?: Record<string, string>;
  option_groups?: Record<string, RepoManifestOptionGroup>;
  slots?: Record<string, RepoManifestSlot>;
  parts?: RepoManifestPartRule[];
  addons?: Array<Record<string, unknown>>;
  choice_tree?: ChoiceTreeNode[];
};

export type ScannedManifestPart = {
  match: string;
  relative_path: string;
};

export type ManifestBuilderBootstrap = {
  source_id: number;
  source: {
    id: number;
    name: string;
    url: string;
    source_kind: string | null;
    role: string;
    local_path: string | null;
  };
  exists: boolean;
  manifest_kind: string | null;
  yaml: string;
  document: RepoManifestDocument;
  scanned_parts: ScannedManifestPart[];
  path: string;
};

export type CommunityExportDraft = {
  slug: string;
  manifest_yaml: string;
  meta_yaml: string;
  issue_body: string;
};

export type SourcesMaintenanceReport = {
  no_manifest: Array<{ id: number; name: string }>;
  catalog_orphans: string[];
  empty_categories: Array<{ id: string; label: string }>;
  drift: Array<{
    source_id: number;
    name: string;
    unmatched: number;
    missing: number;
  }>;
};

export type ImportReposTxtResult = {
  created: number;
  updated: number;
  skipped: number;
  skipped_names: string[];
  results: Array<{
    name: string;
    action: string;
    role?: string;
    source_id?: number;
  }>;
};

export type SourceUploadResult = SourceSummary & {
  imported_files?: number;
  stl_count?: number;
  suggested_import_rules?: string[];
};

export async function exportCommunityManifestDraft(
  projectId: number,
  slug: string,
): Promise<CommunityExportDraft> {
  return engineFetch("/manifest-registry/export-draft", {
    method: "POST",
    body: JSON.stringify({ project_id: projectId, slug }),
  });
}

export async function fetchRepoManifest(sourceId: number): Promise<{
  source_id: number;
  path: string;
  exists: boolean;
  manifest_kind: string | null;
  yaml: string;
  document: RepoManifestDocument;
}> {
  return engineFetch(`/sources/${sourceId}/repo-manifest`);
}

export async function putRepoManifest(
  sourceId: number,
  body: { yaml?: string; document?: RepoManifestDocument },
): Promise<{
  source_id: number;
  path: string;
  saved: boolean;
  yaml: string;
  document: RepoManifestDocument;
}> {
  return engineFetch(`/sources/${sourceId}/repo-manifest`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function fetchManifestBuilder(sourceId: number): Promise<ManifestBuilderBootstrap> {
  return engineFetch(`/sources/${sourceId}/manifest-builder`);
}

export async function generateManifestDraft(sourceId: number): Promise<{
  project_id: number;
  part_count: number;
  yaml: string;
}> {
  return engineFetch(`/sources/${sourceId}/manifest-draft`, { method: "POST" });
}

export async function fetchSourcesMaintenance(): Promise<SourcesMaintenanceReport> {
  return engineFetch<SourcesMaintenanceReport>("/sources/maintenance");
}

export async function importReposTxt(body: { text?: string }): Promise<ImportReposTxtResult> {
  return engineFetch<ImportReposTxtResult>("/sources/import-repos-txt", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function importSourceArchive(sourceId: number, archive: File): Promise<SourceUploadResult> {
  const form = new FormData();
  form.append("file", archive);
  return engineFetchMultipart<SourceUploadResult>({
    path: `/sources/${sourceId}/upload-zip`,
    form,
    failureMessage: "Upload failed",
  });
}

export async function importSourceFiles(sourceId: number, files: File[]): Promise<SourceUploadResult> {
  if (!files.length) throw new Error("Select at least one file to upload");
  const form = new FormData();
  const relativePaths = files.map(
    (file) => file.webkitRelativePath || file.name,
  );
  form.append("relative_paths", JSON.stringify(relativePaths));
  for (const file of files) {
    form.append("files", file);
  }
  return engineFetchMultipart<SourceUploadResult>({
    path: `/sources/${sourceId}/upload-files`,
    form,
    failureMessage: "Upload failed",
  });
}
