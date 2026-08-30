import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  fetchBuildPlanningState,
  fetchCommunityManifest,
  fetchKitCatalog,
  fetchManifestRegistry,
  fetchManifestTemplate,
  fetchManifestTemplates,
  fetchManifestV2,
  fetchPlanKitManifest,
  fetchPlanLayers,
  fetchPlanManifestBuilder,
  fetchPlanManifestSummary,
  fetchPlanManifestWarnings,
  fetchPlanParts,
  fetchPlanReview,
  fetchPlansMaintenance,
  savePlanKitManifest,
  type PlanReview,
} from "./planManifests";

function emptyReview(): PlanReview {
  return {
    profile_id: 7,
    accepted_basis: null,
    plan_name: "Build",
    layers: [],
    totals: {
      included_parts: 0,
      total_print_units: 0,
      by_role: {},
      by_filament: {},
    },
    issues: [],
    has_blockers: false,
    part_groups: [],
  };
}

const http = createEndpointTestHttp();

describe("plan manifest endpoints", () => {
  it("fetches catalog, maintenance, templates, and registry entries", async () => {
    http
      .respond(jsonResponse({ version: 1, bases: {}, addon_categories: {} }))
      .respond(jsonResponse({ plans_with_warnings: [] }))
      .respond(
        jsonResponse({
          templates: [
            { id: "base", label: "Base", category: "kit", available: "always" },
          ],
        }),
      )
      .respond(
        jsonResponse({
          id: "base",
          label: "Base",
          category: "kit",
          yaml: "",
          document: {},
        }),
      )
      .respond(
        jsonResponse({
          entries: [
            {
              slug: "slug",
              target_repo: "repo",
              title: null,
              manifest_file: "pp.yaml",
            },
          ],
        }),
      )
      .respond(jsonResponse({ slug: "slug", yaml: "", document: {} }));

    await fetchKitCatalog();
    await fetchPlansMaintenance();
    await fetchManifestTemplates();
    await fetchManifestTemplate("base");
    await fetchManifestRegistry();
    await fetchCommunityManifest("a slug");

    expect(http.calls[0]?.[0]).toContain("/kit-catalog");
    expect(http.calls[1]?.[0]).toContain("/plans/maintenance");
    expect(http.calls[2]?.[0]).toContain("/manifest-templates");
    expect(http.calls[3]?.[0]).toContain("/manifest-templates/base");
    expect(http.calls[4]?.[0]).toContain("/manifest-registry");
    expect(http.calls[5]?.[0]).toContain("/manifest-registry/a%20slug");
  });

  it("fetches plan manifest and review resources", async () => {
    http
      .respond(
        jsonResponse({ profile_id: 7, sources: [], merged_option_groups: {} }),
      )
      .respond(jsonResponse({ parts: [] }))
      .respond(
        jsonResponse({
          profile_id: 7,
          required: { total: 0, included: 0 },
          optional: { total: 0, included: 0 },
          recommended: { total: 0, included: 0 },
          option_groups: [],
        }),
      )
      .respond(jsonResponse({ warnings: [] }))
      .respond(jsonResponse(emptyReview()))
      .respond(
        jsonResponse({
          profile_id: 7,
          version: 1,
          yaml: "",
          plan: { name: null, base_source_id: null, addon_source_ids: [] },
          sources: [],
          selections: {},
          option_groups: {},
          option_group_count: 0,
          addon_count: 0,
        }),
      )
      .respond(
        jsonResponse({
          kit: {
            name: null,
            layers: [],
            selections: {},
            include: [],
            exclude: [],
          },
        }),
      )
      .respond(
        jsonResponse({
          kit: {
            name: "Kit",
            layers: [],
            selections: {},
            include: [],
            exclude: [],
          },
        }),
      )
      .respond(jsonResponse({ layers: [] }))
      .respond(jsonResponse({ planning: null }))
      .respond(jsonResponse({ parts: [] }))
      .respond(jsonResponse({ warnings: [] }));

    await fetchPlanManifestBuilder(7);
    await fetchPlanParts(7);
    await fetchPlanManifestSummary(7);
    await fetchPlanManifestWarnings(7);
    await fetchPlanReview(7, { includeExcluded: true });
    await fetchManifestV2(7);
    await fetchPlanKitManifest(7);
    await savePlanKitManifest(7, {
      name: "Kit",
      layers: [],
      selections: {},
      include: [],
      exclude: [],
    });
    await fetchPlanLayers(7);
    await fetchBuildPlanningState(7, 17);
    await fetchPlanParts(7);
    await fetchPlanManifestWarnings(7);

    expect(http.calls[0]?.[0]).toContain("/plans/7/plan-manifest-builder");
    expect(http.calls[4]?.[0]).toContain(
      "/plans/7/review?include_excluded=true",
    );
    expect(http.requestJson(7)).toEqual({
      kit: {
        name: "Kit",
        layers: [],
        selections: {},
        include: [],
        exclude: [],
      },
    });
    expect(http.calls[9]?.[0]).toContain("/plans/7/build-planning?draft_id=17");
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
