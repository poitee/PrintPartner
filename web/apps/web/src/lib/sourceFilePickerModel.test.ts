import { describe, expect, it } from "vitest";
import type { SourceSummary } from "@print-partner/contracts";
import { attachedSourceStateLabel } from "./sourceFilePickerModel";

function source(overrides: Partial<SourceSummary> = {}): SourceSummary {
  return {
    id: 1,
    name: "Source",
    url: "https://example.com/repo.git",
    source_kind: "github",
    source_type: "git",
    role: "unassigned",
    category: null,
    branch: "main",
    tag: null,
    local_path: null,
    last_synced_at: "2026-08-26T00:00:00.000Z",
    last_commit_sha: null,
    current_source_revision_id: null,
    docs_url: null,
    manifest_community_slug: null,
    metadata: {},
    update_status: "unknown",
    update_checked_at: null,
    doc_count: 0,
    ...overrides,
  };
}

const formatDate = (iso: string | null | undefined) => (iso ? "Aug 26" : "");

describe("attachedSourceStateLabel", () => {
  it("prefers active sync state", () => {
    expect(
      attachedSourceStateLabel({
        source: source({ update_status: "updates_available" }),
        formatDate,
        selectedCount: 0,
        totalFiles: 0,
        syncing: true,
        syncMessage: "Syncing 40%",
      }),
    ).toEqual({ text: "Syncing 40%", tone: "sync" });
  });

  it("shows update warnings", () => {
    expect(
      attachedSourceStateLabel({
        source: source({ update_status: "updates_available" }),
        formatDate,
        selectedCount: 0,
        totalFiles: 0,
        syncing: false,
        syncMessage: "",
      }),
    ).toEqual({ text: "update available", tone: "warn" });
  });

  it("shows local folder file counts", () => {
    expect(
      attachedSourceStateLabel({
        source: source({ source_kind: "local", local_path: "/repo" }),
        formatDate,
        selectedCount: 2,
        totalFiles: 5,
        syncing: false,
        syncMessage: "",
      }),
    ).toEqual({ text: "local folder · always current · 2 of 5 files", tone: "muted" });
  });

  it("shows synced timestamp and picks", () => {
    expect(
      attachedSourceStateLabel({
        source: source(),
        formatDate,
        selectedCount: 3,
        totalFiles: 0,
        syncing: false,
        syncMessage: "",
      }),
    ).toEqual({ text: "synced Aug 26 · 3 picks", tone: "muted" });
  });

  it("warns before first sync", () => {
    expect(
      attachedSourceStateLabel({
        source: source({ last_synced_at: null }),
        formatDate,
        selectedCount: 0,
        totalFiles: 0,
        syncing: false,
        syncMessage: "",
      }),
    ).toEqual({ text: "not synced", tone: "warn" });
  });
});
