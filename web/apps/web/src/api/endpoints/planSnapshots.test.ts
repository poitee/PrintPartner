import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  createPlanSnapshotApi,
  fetchPlanRecipe,
  fetchPlanSnapshots,
  restorePlanSnapshotApi,
} from "./planSnapshots";

const http = createEndpointTestHttp();

describe("plan snapshot endpoints", () => {
  it("fetches recipe and snapshots, creates and restores snapshots", async () => {
    http
      .respond(jsonResponse({ steps: [] }))
      .respond(jsonResponse({ snapshots: [] }))
      .respond(jsonResponse({ id: 2 }))
      .respond(jsonResponse({ ok: true }));

    await fetchPlanRecipe(7);
    await fetchPlanSnapshots(7);
    await createPlanSnapshotApi(7, { name: "Before", source: "user" });
    await restorePlanSnapshotApi(7, 2);

    expect(http.calls[0]?.[0]).toContain("/plans/7/recipe");
    expect(http.calls[1]?.[0]).toContain("/plans/7/snapshots");
    expect(http.requestJson(2)).toEqual({ name: "Before", source: "user" });
    expect(http.calls[3]?.[0]).toContain("/plans/7/snapshots/2/restore");
    expect(http.requestJson(3)).toEqual({});
  });
});
