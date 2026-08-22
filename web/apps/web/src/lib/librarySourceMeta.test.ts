import { describe, expect, it } from "vitest";
import type { PlanReview, SourceSummary } from "../api/engine";
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
});
