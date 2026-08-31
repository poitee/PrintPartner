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
    ).toEqual({
      automaticCount: 2,
      manualTrackedCount: 1,
      updateCount: 1,
      lastCheckedAt: "2026-08-31T10:00:00.000Z",
    });
  });

  it("provides provider-specific URL examples", () => {
    expect(sourceModelUrlPlaceholder("thangs")).toContain("thangs.com");
    expect(sourceModelUrlPlaceholder("makerworld")).toContain("makerworld.com");
  });
});
