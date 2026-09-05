import type { SourceSummary } from "@print-partner/contracts";
import {
  parseProjectMetadata,
  parseSourceNamingMetadata,
  resolveSourceCategory,
} from "@print-partner/domain";
import { REMOTE_CHECKED_AT_KEY, REMOTE_UPDATE_STATUS_KEY } from "../services/source-update-check.js";

export type SourceSummaryProjectRow = {
  id: number;
  name: string;
  url: string;
  sourceKind: string | null;
  sourceType: string | null;
  role: string | null;
  metadataJson: string | null;
  branch: string | null;
  tag: string | null;
  localPath: string | null;
  lastSyncedAt: string | null;
  lastCommitSha: string | null;
  currentSourceRevisionId: number | null;
  docsUrl: string | null;
  manifestCommunitySlug: string | null;
};

export function readSourceUpdateFields(metadata: Record<string, unknown> | null): {
  update_status: "up_to_date" | "updates_available" | "unknown" | null;
  update_checked_at: string | null;
} {
  const data = metadata ?? {};
  const status = data[REMOTE_UPDATE_STATUS_KEY];
  const valid: "up_to_date" | "updates_available" | "unknown" | null =
    status === "up_to_date" || status === "updates_available" || status === "unknown" ? status : null;
  const checked = data[REMOTE_CHECKED_AT_KEY];
  return {
    update_status: valid,
    update_checked_at: typeof checked === "string" ? checked : null,
  };
}

export function sourceSummary(row: SourceSummaryProjectRow, docCount = 0): SourceSummary {
  const metadata = parseProjectMetadata(row.metadataJson);
  const { useDefaults } = parseSourceNamingMetadata(metadata);
  const { update_status, update_checked_at } = readSourceUpdateFields(metadata);
  const sourceKind = row.sourceKind || (row.sourceType === "local" ? "local" : "github");
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    source_kind: sourceKind,
    source_type: row.sourceType ?? "git",
    role: row.role ?? "unassigned",
    category: resolveSourceCategory(row.metadataJson, row.role),
    branch: row.branch ?? "main",
    tag: row.tag ?? null,
    local_path: row.localPath,
    content_available: Boolean(row.localPath),
    last_synced_at: row.lastSyncedAt,
    last_commit_sha: row.lastCommitSha,
    current_source_revision_id: row.currentSourceRevisionId,
    docs_url: row.docsUrl,
    manifest_community_slug: row.manifestCommunitySlug,
    metadata,
    naming_use_defaults: useDefaults,
    update_status,
    update_checked_at,
    doc_count: docCount,
  };
}
