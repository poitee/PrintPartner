import type { SourceSummary } from "@print-partner/contracts";
import type { SourceKind } from "../components/sources/sourceLabels";

export type SyncingSourceIds = number[] | "all" | null;

export type ReposImportResultLike = {
  created: number;
  updated: number;
  skipped: number;
  skipped_names: string[];
  results: Array<{
    action: string;
    source_id?: number | null;
    name: string;
  }>;
};

export type NewImportedSource = { source_id: number; name: string };

export function sourceKindNeedsArchiveUpload(kind: SourceKind): boolean {
  return (
    kind === "archive" ||
    kind === "printables" ||
    kind === "makerworld" ||
    kind === "thangs"
  );
}

export function sourceKindCanUpload(kind: SourceKind): boolean {
  return kind === "local" || sourceKindNeedsArchiveUpload(kind);
}

export function sourceCanUpload(source: Pick<SourceSummary, "source_kind">): boolean {
  return sourceKindCanUpload(source.source_kind as SourceKind);
}

export function missingSourceUploadMessage(kind: SourceKind): string {
  if (kind === "local") return "Select STL files or a folder to upload.";
  return kind === "archive"
    ? "A ZIP archive is required for this source."
    : "Upload the model archive you downloaded from the site.";
}

export function sourceSyncLabel(ids?: number[]): string {
  if (ids?.length === 1) return "Source synced";
  if (ids && ids.length > 1) return `Synced ${ids.length} sources`;
  return "All sources synced";
}

export function sourceIsSyncing(input: {
  busy: boolean;
  syncingSourceIds: SyncingSourceIds;
  sourceId: number;
}): boolean {
  if (!input.busy || input.syncingSourceIds == null) return false;
  if (input.syncingSourceIds === "all") return true;
  return input.syncingSourceIds.includes(input.sourceId);
}

export function formatReposImportMessage(result: ReposImportResultLike): string {
  const skipped =
    result.skipped > 0
      ? ` Skipped ${result.skipped} line(s) without URL${
          result.skipped_names.length ? `: ${result.skipped_names.join(", ")}` : ""
        }.`
      : "";
  return `Imported ${result.created} new and updated ${result.updated} source(s).${skipped}`;
}

export function createdSourcesFromReposImport(
  result: ReposImportResultLike,
): NewImportedSource[] {
  return result.results
    .filter((row) => row.action === "created" && row.source_id != null)
    .map((row) => ({ source_id: row.source_id as number, name: row.name }));
}

export function formatReposSyncSummary(input: {
  total: number;
  failures: string[];
}): string | null {
  if (input.failures.length > 0) {
    return `Sync finished with ${input.failures.length} failure(s): ${input.failures
      .slice(0, 3)
      .join("; ")}${input.failures.length > 3 ? "…" : ""}`;
  }
  if (input.total > 0) return `Synced ${input.total} new source(s).`;
  return null;
}
