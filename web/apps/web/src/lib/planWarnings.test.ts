import { describe, expect, it } from "vitest";
import { buildPlanWarningLines, planHeaderSubtitle } from "./planWarnings";
import type { PlanReview, ProfileSummary, SourceSummary } from "../api/engine";

function source(partial: Partial<SourceSummary> & Pick<SourceSummary, "id" | "name">): SourceSummary {
  return {
    url: "",
    source_kind: "github",
    source_type: "git",
    role: "unassigned",
    category: null,
    branch: "main",
    tag: null,
    local_path: "/tmp",
    last_synced_at: "2026-01-01T00:00:00Z",
    last_commit_sha: null,
    current_source_revision_id: null,
    docs_url: null,
    manifest_community_slug: null,
    metadata: null,
    ...partial,
  };
}

describe("buildPlanWarningLines", () => {
  it("flags upstream updates; skips soft role noise", () => {
    const lines = buildPlanWarningLines({
      buildStale: false,
      attachedSources: [
        source({ id: 1, name: "A", update_status: "updates_available" }),
        source({ id: 2, name: "B", update_status: "up_to_date" }),
      ],
      review: {
        profile_id: 1,
        accepted_basis: null,
        plan_name: "Test",
        layers: [],
        totals: { included_parts: 2, total_print_units: 2, by_role: {}, by_filament: {} },
        issues: [],
        has_blockers: false,
        part_groups: [
          {
            folder: "/",
            source_layer: null,
            parts: [
              {
                id: 1,
                match_key: "a",
                relative_path: "a.stl",
                filename: "a.stl",
                source_layer: null,
                status: "ok",
                role: "unassigned",
                requirement: null,
                option_group_id: null,
                included: true,
                filament_color_id: null,
                quantity_auto: 1,
                quantity_override: null,
                quantity_effective: 1,
                printed_count: 0,
                print_units: [false],
                missing: false,
                filament_display: "",
              },
            ],
          },
        ],
      } as PlanReview,
    });
    expect(lines.some((l) => l.includes("updated upstream"))).toBe(true);
    expect(lines.some((l) => l.includes("no filament role"))).toBe(false);
  });

  it("falls back to stale when no upstream badge", () => {
    const lines = buildPlanWarningLines({
      buildStale: true,
      attachedSources: [source({ id: 1, name: "A", update_status: "up_to_date" })],
      review: null,
    });
    expect(lines[0]).toMatch(/plan inputs changed/i);
  });
});

describe("planHeaderSubtitle", () => {
  it("joins name, sources, parts", () => {
    const profile = { id: 1, name: "Voron Trident 300", order_number: null, special_request: null, part_count: 359, accepted_progress: { kind: "ready", remaining_units: 0, total_units: 359 }, build_stale: false, freshness: { status: "current", accepted_input_set_id: 1, accepted_at: "2026-08-20T12:00:00.000Z" }, archived_at: null, last_used_at: null } satisfies ProfileSummary;
    expect(planHeaderSubtitle({ profile, sourceCount: 4, partCount: 359 })).toBe(
      "Voron Trident 300 · 4 sources · 359 parts",
    );
  });
});
