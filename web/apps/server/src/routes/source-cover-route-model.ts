import type { SourceCoverProject } from "../lib/source-cover.js";

export type SourceCoverProjectRow = {
  id: number;
  url: string;
  sourceKind: string | null;
  sourceType: string | null;
  localPath: string | null;
  lastSyncedAt: string | null;
  metadataJson: string | null;
};

export function toCoverProject(row: SourceCoverProjectRow): SourceCoverProject {
  return {
    id: row.id,
    url: row.url,
    sourceKind: row.sourceKind,
    sourceType: row.sourceType,
    localPath: row.localPath,
    lastSyncedAt: row.lastSyncedAt,
    metadataJson: row.metadataJson,
  };
}
