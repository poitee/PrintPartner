import { describe, expect, it } from "vitest";
import type { SourceSummary } from "@print-partner/contracts";
import {
  sourceModelUrlPlaceholder,
  sourceMonitoringCapability,
  sourceMonitoringSummary,
} from "./sourceMonitoring";

function source(patch: Partial<SourceSummary>): SourceSummary {
  return {
    id: 1,
    name: "Source",
    url: "",
    branch: "main",
    tag: null,
    source_kind: "github",
    source_type: "git",
    role: "unassigned",
    local_path: null,
    last_synced_at: null,
    last_commit_sha: null,
    current_source_revision_id: null,
    docs_url: null,
    manifest_community_slug: null,
    metadata: null,
    doc_count: 0,
    category: null,
    update_status: "unknown",
    update_checked_at: null,
    ...patch,
  };
}

describe("source monitoring", () => {
  it("separates automatic repositories from tracked model pages", () => {
    expect(sourceMonitoringCapability("github")).toBe("automatic");
    expect(sourceMonitoringCapability("printables")).toBe("manual_model");
    expect(sourceMonitoringCapability("makerworld")).toBe("manual_model");
    expect(sourceMonitoringCapability("thangs")).toBe("manual_model");
    expect(sourceMonitoringCapability("archive")).toBe("local");
  });

  it("summarises coverage, updates, and the latest check", () => {
    expect(
      sourceMonitoringSummary([
        source({ id: 1, update_status: "updates_available", update_checked_at: "2026-08-30T10:00:00.000Z" }),
        source({ id: 2, source_kind: "thangs", source_type: "local" }),
        source({ id: 3, update_checked_at: "2026-08-31T10:00:00.000Z" }),
      ]),
    ).toMatchObject({
      automaticCount: 2,
      manualTrackedCount: 1,
      updateCount: 1,
      lastCheckedAt: "2026-08-31T10:00:00.000Z",
    });
  });

  it("separates repositories needing sync from repositories whose update status is unknown", () => {
    const summary = sourceMonitoringSummary([
      source({ id: 1, last_synced_at: "2026-09-29T12:00:00Z", metadata: { sync_required: true, sync_error: "No commit found" } }),
      source({ id: 2, metadata: { sync_required: true } }),
      source({ id: 3, update_status: "unknown" }),
      source({ id: 4, update_status: null }),
      source({ id: 5, update_status: "up_to_date" }),
      source({ id: 6, source_kind: "archive", update_status: "unknown" }),
    ]);
    expect(summary).toMatchObject({ automaticCount: 5, attentionCount: 2, unknownCount: 2 });
  });

  it("provides provider-specific URL examples", () => {
    expect(sourceModelUrlPlaceholder("thangs")).toContain("thangs.com");
    expect(sourceModelUrlPlaceholder("makerworld")).toContain("makerworld.com");
  });
});
