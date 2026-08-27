import { describe, expect, it } from "vitest";
import { sourceRevision, type SourceRevisionDbRow } from "./source-revision-model.js";

const completeRow: SourceRevisionDbRow = {
  id: 9,
  projectId: 4,
  upstreamRevisionKey: "commit:abc",
  manifestDigest: "digest",
  snapshotLocator: "snapshots/4/9",
  syncedAt: "2026-08-26T00:00:00.000Z",
  completeness: "complete",
};

describe("sourceRevision", () => {
  it("maps a complete Source revision row to the API contract", () => {
    expect(sourceRevision(completeRow)).toEqual({
      id: 9,
      source_id: 4,
      upstream_revision_key: "commit:abc",
      manifest_digest: "digest",
      snapshot_locator: "snapshots/4/9",
      synced_at: "2026-08-26T00:00:00.000Z",
      completeness: "complete",
    });
  });

  it("rejects incomplete sync attempts", () => {
    expect(() => sourceRevision({ ...completeRow, completeness: "failed" })).toThrow(
      "Incomplete sync attempt is not a Source revision",
    );
  });
});
