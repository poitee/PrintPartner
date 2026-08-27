import { describe, expect, it } from "vitest";
import { buildPageDerivedState } from "./buildPageViewModel";
import type { ProfileSummary } from "@print-partner/contracts";
import type { PlanReview } from "../api/endpoints/planManifests";

const profile: ProfileSummary = {
  id: 7,
  name: "Build",
  order_number: null,
  special_request: null,
  part_count: 2,
  accepted_progress: { kind: "ready", total_units: 2, remaining_units: 1 },
  build_stale: false,
  freshness: { status: "current", accepted_input_set_id: 1, accepted_at: "2026-08-25T00:00:00.000Z" },
  archived_at: null,
  last_used_at: null,
};

const review: PlanReview = {
  profile_id: 7,
  accepted_basis: null,
  plan_name: "Build",
  layers: [],
  totals: { included_parts: 3, total_print_units: 3, by_role: {}, by_filament: {} },
  issues: [],
  has_blockers: false,
  part_groups: [
    {
      folder: "parts",
      source_layer: null,
      parts: [
        {
          id: 1,
          match_key: "part.stl",
          filename: "part.stl",
          relative_path: "part.stl",
          source_layer: null,
          status: "active",
          role: "part",
          requirement: null,
          option_group_id: null,
          included: true,
          filament_color_id: null,
          quantity_auto: 2,
          quantity_override: null,
          quantity_effective: 2,
          missing: true,
          printed_count: 1,
          print_units: [true, false],
          filament_display: "Unset",
        },
      ],
    },
  ],
};

describe("buildPageDerivedState", () => {
  it("builds the header line and archive state", () => {
    const state = buildPageDerivedState({
      selectedProfile: profile,
      review,
      attachedSources: [],
      roleFilaments: [],
      sourceCardLayerCount: 1,
      buildStale: false,
    });

    expect(state.partCount).toBe(2);
    expect(state.headerSubtitle).toContain("2 parts");
    expect(state.headerSubtitle).toContain("1 source");
    expect(state.archiveAllowed).toBe(false);
  });

  it("falls back to review part totals when the profile count is absent", () => {
    const state = buildPageDerivedState({
      selectedProfile: { ...profile, part_count: 0 },
      review,
      attachedSources: [],
      roleFilaments: [],
      sourceCardLayerCount: 0,
      buildStale: false,
    });

    expect(state.partCount).toBe(0);
  });
});
