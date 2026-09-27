import type { ManifestSelections, SourceSummary } from "@print-partner/contracts";
import { engineFetch, engineFetchMultipart } from "../engineTransport";

type ChoiceTreeNode = {
  id: string;
  label?: string;
  type?: "pick_one" | "pick_any" | "pick_n" | "addon_toggle";
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

type RepoManifestVariantSource = {
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
  rule: "pick_one" | "pick_any" | "pick_n";
  label?: string;
  parts?: Array<{ match: string } | string>;
  variants?: RepoManifestVariant[];
  min?: number | null;
  max?: number | null;
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
  selections?: ManifestSelections;
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

type ImportReposTxtResult = {
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

type SourceUploadResult = SourceSummary & {
  imported_files?: number;
  stl_count?: number;
  suggested_import_rules?: string[];
};

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
