import { describe, expect, it } from "vitest";
import type { SourceSummary } from "@print-partner/contracts";
import type { PlanReview } from "../api/endpoints/planManifests";
import {
  attachedSourceIds,
  buildLibraryCardMeta,
  pickCountsBySourceId,
  sourceSlug,
} from "./librarySourceMeta";

function source(partial: Partial<SourceSummary> & Pick<SourceSummary, "id" | "name">): SourceSummary {
  return {
    url: "",
    source_kind: "github",
    source_type: "git",
    role: "",
    category: null,
    branch: "main",
    tag: null,
    local_path: null,
    last_synced_at: null,
    last_commit_sha: null,
    current_source_revision_id: null,
    docs_url: null,
    manifest_community_slug: null,
    metadata: null,
    ...partial,
  };
}

describe("librarySourceMeta", () => {
  it("extracts github org/repo slug", () => {
    expect(
      sourceSlug(
        source({
          id: 1,
          name: "Trident",
          url: "https://github.com/VoronDesign/Voron-Trident.git",
        }),
      ),
    ).toBe("VoronDesign/Voron-Trident");
  });

  it("counts attached picks per source from review", () => {
    const review = {
      layers: [
        {
          id: 1,
          layer_type: "base",
          project_id: 10,
          project_name: "Trident",
          local_path: null,
          synced: true,
          last_synced_at: null,
        },
        {
          id: 2,
          layer_type: "addon",
          project_id: 20,
          project_name: "Klicky",
          local_path: null,
          synced: true,
          last_synced_at: null,
        },
      ],
      part_groups: [
        {
          folder: "gantry",
          source_layer: "base:Trident",
          parts: [
            { included: true, source_layer: "base:Trident" },
            { included: true, source_layer: "base:Trident" },
            { included: false, source_layer: "base:Trident" },
            { included: true, source_layer: "addon:Klicky" },
          ],
        },
      ],
    } as unknown as PlanReview;

    expect([...attachedSourceIds(review)].sort()).toEqual([10, 20]);
    const picks = pickCountsBySourceId(review);
    expect(picks.get(10)).toBe(2);
    expect(picks.get(20)).toBe(1);
  });

  it("marks update-available cards with amber bar", () => {
    const meta = buildLibraryCardMeta({
      source: source({
        id: 1,
        name: "Stealthburner",
        update_status: "updates_available",
        url: "https://github.com/VoronDesign/Voron-Stealthburner",
      }),
      attached: true,
      pickCount: 12,
      syncing: false,
      syncProgress: null,
      formatDate: () => "2h ago",
    });
    expect(meta.stateLabel).toBe("Update available");
    expect(meta.pickLabel).toBe("12 picks");
    expect(meta.barTone).toBe("update");
    expect(meta.barPct).toBe(100);
  });

  it("leaves unattached sources with an empty bar", () => {
    const meta = buildLibraryCardMeta({
      source: source({
        id: 2,
        name: "Skirts",
        source_kind: "archive",
        last_synced_at: "2024-03-14T00:00:00Z",
      }),
      attached: false,
      pickCount: null,
      syncing: false,
      syncProgress: null,
      formatDate: () => "14 Mar",
    });
    expect(meta.pickLabel).toBe("not attached");
    expect(meta.barPct).toBe(0);
  });

  it.each([
    [{ sync_required: true, sync_error: "No commit found for missing-tag" }, "Sync failed"],
    [{ sync_required: true }, "Sync required"],
  ])("shows the current sync issue despite a retained successful timestamp (%j)", (metadata, label) => {
    const meta = buildLibraryCardMeta({
      source: source({
        id: 6,
        name: "Retained Source",
        last_synced_at: "2026-09-29T12:00:00Z",
        update_status: "unknown",
        metadata,
      }),
      attached: true,
      pickCount: 3,
      syncing: false,
      syncProgress: null,
      formatDate: () => "29 Sep",
    });
    expect(meta.stateLabel).toBe(label);
    expect(meta.stateTone).toBe("warning");
  });

  it("shows active sync before a retained failure", () => {
    const meta = buildLibraryCardMeta({
      source: source({ id: 6, name: "Retrying Source", metadata: { sync_error: "Previous failure" } }),
      attached: false,
      pickCount: null,
      syncing: true,
      syncProgress: 0.5,
      formatDate: () => "29 Sep",
    });
    expect(meta.stateLabel).toBe("Syncing 50%");
  });
});
