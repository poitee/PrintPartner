import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  fetchBuildPlanningState,
  fetchPlanReview,
} from "./planManifests";

const http = createEndpointTestHttp();

const part = {
  id: 1, match_key: "frame.stl", relative_path: "frame.stl", filename: "frame.stl",
  source_layer: "base:Voron", status: "ready", role: "frame", requirement: null,
  option_group_id: null, included: true, filament_color_id: null,
  quantity_auto: 2, quantity_override: null, quantity_effective: 2,
  print_units: [true, false], assembled_units: [false, false], printed_count: 1,
  missing: true, filament_display: "ABS", filament_hex: "#ffffff",
  stl_missing: false, thumb_empty: true, spool_summary: [{ remaining_g: 100, spool_id: 2 }],
  spool_badge: null,
};

const review = {
  profile_id: 7,
  accepted_basis: {
    profile_id: 7, plan_version: 1, plan_revision_id: 3,
    plan_revision_digest: "a".repeat(64), required_unit_mapping_digest: "b".repeat(64),
  },
  plan_name: "Voron", layers: [], issues: [], has_blockers: false, part_groups: [],
  totals: { included_parts: 0, total_print_units: 0, by_role: {}, by_filament: {} },
};

describe("plan manifest endpoints", () => {
  it("reads an empty Build and includes excluded parts only when requested", async () => {
    const empty = { ...review, accepted_basis: null };
    http.respond(jsonResponse(empty));
    await expect(fetchPlanReview(7, { includeExcluded: true })).resolves.toEqual(empty);
    expect(http.request().url).toBe("/plans/7/review?include_excluded=true");
  });

  it("preserves complete rows and additional server fields", async () => {
    const value = { ...review, future_field: "preserved",
      part_groups: [{ folder: "", source_layer: "base:Voron", parts: [part] }] };
    http.respond(jsonResponse(value));
    await expect(fetchPlanReview(7)).resolves.toEqual(value);
  });

  it.each([
    { ...review, part_groups: [{ folder: "", source_layer: null, parts: [{ ...part, print_units: ["yes"] }] }] },
    { ...review, part_groups: [{ folder: "", source_layer: null, parts: [{ ...part, id: Number.MAX_SAFE_INTEGER + 1 }] }] },
    { ...review, profile_id: 8 },
    { ...review, accepted_basis: { ...review.accepted_basis, profile_id: 8 } },
    { ...review, part_groups: null },
    { ...review, layers: [null] },
    { ...review, issues: [{ code: "x", message: "y", severity: "unknown" }] },
    { ...review, totals: { ...review.totals, by_role: { frame: "many" } } },
  ])("rejects a mismatched or unreadable Review before cache hydration", async (value) => {
    http.respond(jsonResponse(value));
    await expect(fetchPlanReview(7)).rejects.toThrow();
  });

  it("returns advisory Preparation state without a publication gate", async () => {
    http.respond(
      jsonResponse({
        planning: {
          planning_phase: { kind: "draft", draft_id: 9 },
          brief: {
            special_request: "",
            requirements: [],
            evidence: [],
            contributions: [],
            role_filaments: [],
          },
          readiness: { ready: true, blockers: [] },
          grouped_difference_count: 0,
          difference_count: 0,
        },
      }),
    );

    const planning = await fetchBuildPlanningState(7, 9);

    expect(planning?.readiness).toEqual({ ready: true, blockers: [] });
    expect(planning).not.toHaveProperty("acceptance_readiness");
  });
});
