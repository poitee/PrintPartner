import { describe, expect, it } from "vitest";
import {
  createdSourcesFromReposImport,
  formatReposImportMessage,
  formatReposSyncSummary,
  missingSourceUploadMessage,
  sourceIsSyncing,
  sourceKindCanUpload,
  sourceKindNeedsArchiveUpload,
  sourceSyncLabel,
} from "./sourceImportModel";

describe("sourceImportModel", () => {
  it("classifies upload behavior by source kind", () => {
    expect(sourceKindCanUpload("local")).toBe(true);
    expect(sourceKindCanUpload("archive")).toBe(true);
    expect(sourceKindCanUpload("printables")).toBe(true);
    expect(sourceKindCanUpload("makerworld")).toBe(true);
    expect(sourceKindCanUpload("github")).toBe(false);
    expect(sourceKindNeedsArchiveUpload("printables")).toBe(true);
    expect(sourceKindNeedsArchiveUpload("local")).toBe(false);
  });

  it("formats missing upload and sync labels", () => {
    expect(missingSourceUploadMessage("local")).toBe("Select STL files or a folder to upload.");
    expect(missingSourceUploadMessage("archive")).toBe("A ZIP archive is required for this source.");
    expect(missingSourceUploadMessage("makerworld")).toBe("Upload the model archive you downloaded from the site.");
    expect(sourceSyncLabel([1])).toBe("Source synced");
    expect(sourceSyncLabel([1, 2])).toBe("Synced 2 sources");
    expect(sourceSyncLabel()).toBe("All sources synced");
  });

  it("detects active source sync state", () => {
    expect(sourceIsSyncing({ busy: false, syncingSourceIds: "all", sourceId: 1 })).toBe(false);
    expect(sourceIsSyncing({ busy: true, syncingSourceIds: "all", sourceId: 1 })).toBe(true);
    expect(sourceIsSyncing({ busy: true, syncingSourceIds: [2], sourceId: 1 })).toBe(false);
    expect(sourceIsSyncing({ busy: true, syncingSourceIds: [1], sourceId: 1 })).toBe(true);
  });

  it("formats repos.txt import results and created source rows", () => {
    const result = {
      created: 2,
      updated: 1,
      skipped: 1,
      skipped_names: ["bad line"],
      results: [
        { action: "created", source_id: 1, name: "One" },
        { action: "updated", source_id: 2, name: "Two" },
        { action: "created", source_id: null, name: "Missing" },
      ],
    };

    expect(formatReposImportMessage(result)).toBe(
      "Imported 2 new and updated 1 source(s). Skipped 1 line(s) without URL: bad line.",
    );
    expect(createdSourcesFromReposImport(result)).toEqual([{ source_id: 1, name: "One" }]);
  });

  it("summarizes sequential sync results", () => {
    expect(formatReposSyncSummary({ total: 2, failures: [] })).toBe("Synced 2 new source(s).");
    expect(formatReposSyncSummary({ total: 0, failures: [] })).toBeNull();
    expect(formatReposSyncSummary({ total: 4, failures: ["a", "b", "c", "d"] })).toBe(
      "Sync finished with 4 failure(s): a; b; c…",
    );
  });
});
