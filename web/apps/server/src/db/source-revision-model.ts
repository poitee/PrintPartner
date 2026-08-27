import type { SourceRevision } from "@print-partner/contracts";

export type SourceRevisionDbRow = {
  id: number;
  projectId: number;
  upstreamRevisionKey: string;
  manifestDigest: string;
  snapshotLocator: string;
  syncedAt: string;
  completeness: string;
};

export function sourceRevision(row: SourceRevisionDbRow): SourceRevision {
  if (row.completeness !== "complete") {
    throw new Error("Incomplete sync attempt is not a Source revision");
  }
  return {
    id: row.id,
    source_id: row.projectId,
    upstream_revision_key: row.upstreamRevisionKey,
    manifest_digest: row.manifestDigest,
    snapshot_locator: row.snapshotLocator,
    synced_at: row.syncedAt,
    completeness: "complete",
  };
}
