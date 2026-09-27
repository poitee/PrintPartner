import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  fetchBuildPlanningState,
} from "./planManifests";

const http = createEndpointTestHttp();

describe("plan manifest endpoints", () => {

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
