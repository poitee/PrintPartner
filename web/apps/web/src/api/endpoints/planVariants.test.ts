import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  applyPlanVariantSelection,
  fetchPlanPhaseManifest,
  fetchPlanVariantDimensions,
} from "./planVariants";

const http = createEndpointTestHttp();

describe("plan variant endpoints", () => {
  it("returns an empty phase manifest when the server reports no manifest", async () => {
    http.respond(jsonResponse({ detail: "missing" }, 404));

    await expect(fetchPlanPhaseManifest(7)).resolves.toEqual({
      profile_id: 7,
      has_phases: false,
      phases: [],
    });
  });

  it("fetches dimensions and applies selections", async () => {
    http
      .respond(
        jsonResponse({
          profile_id: 7,
          source_id: 2,
          dimensions: { size: ["a"] },
          selection: {},
        }),
      )
      .respond(
        jsonResponse({
          profile_id: 7,
          source_id: 2,
          rules: ["size=a"],
          selection: { size: "a" },
        }),
      );

    await fetchPlanVariantDimensions(7);
    await applyPlanVariantSelection(7, { size: "a" }, 2);

    expect(http.calls[0]?.[0]).toContain("/plans/7/variant-dimensions");
    expect(http.calls[1]?.[0]).toContain("/plans/7/variant-selection");
    expect(http.requestJson(1)).toEqual({
      selection: { size: "a" },
      source_id: 2,
    });
  });
});
