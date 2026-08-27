import { describe, expect, it } from "vitest";
import {
  readSourceUpdateFields,
  sourceSummary,
  type SourceSummaryProjectRow,
} from "./source-summary-model.js";

function row(overrides: Partial<SourceSummaryProjectRow> = {}): SourceSummaryProjectRow {
  return {
    id: 4,
    name: "Voron",
    url: "https://example.com/voron.git",
    sourceKind: null,
    sourceType: "git",
    role: null,
    metadataJson: null,
    branch: null,
    tag: null,
    localPath: null,
    lastSyncedAt: null,
    lastCommitSha: null,
    currentSourceRevisionId: null,
    docsUrl: null,
    manifestCommunitySlug: null,
    ...overrides,
  };
}

describe("readSourceUpdateFields", () => {
  it("returns known update state and checked timestamp", () => {
    expect(
      readSourceUpdateFields({
        remote_update_status: "updates_available",
        remote_checked_at: "2026-08-26T00:00:00.000Z",
      }),
    ).toEqual({
      update_status: "updates_available",
      update_checked_at: "2026-08-26T00:00:00.000Z",
    });
  });

  it("drops invalid update metadata", () => {
    expect(readSourceUpdateFields({ remote_update_status: "bad", remote_checked_at: 1 })).toEqual({
      update_status: null,
      update_checked_at: null,
    });
  });
});

describe("sourceSummary", () => {
  it("maps defaults for a git source", () => {
    expect(sourceSummary(row(), 3)).toMatchObject({
      id: 4,
      source_kind: "github",
      source_type: "git",
      role: "unassigned",
      branch: "main",
      doc_count: 3,
      update_status: null,
      update_checked_at: null,
    });
  });

  it("infers local source kind from source type", () => {
    expect(sourceSummary(row({ sourceType: "local" })).source_kind).toBe("local");
  });

  it("preserves explicit source kind and parsed metadata", () => {
    const summary = sourceSummary(
      row({
        sourceKind: "upload",
        metadataJson: JSON.stringify({
          category: "Frames",
          remote_update_status: "up_to_date",
        }),
      }),
    );

    expect(summary.source_kind).toBe("upload");
    expect(summary.category).toBe("Frames");
    expect(summary.metadata).toMatchObject({ category: "Frames" });
    expect(summary.update_status).toBe("up_to_date");
  });
});
