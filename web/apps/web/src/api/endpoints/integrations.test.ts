import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  createIntegration,
  deleteIntegration,
  fetchIntegrationStatus,
  fetchIntegrations,
  testIntegration,
  updateIntegration,
} from "./integrations";

const http = createEndpointTestHttp();

describe("integration endpoints", () => {
  it("fetches integrations and host status", async () => {
    http
      .respond(jsonResponse({ integrations: [] }))
      .respond(jsonResponse({ state: "idle" }));

    await expect(fetchIntegrations()).resolves.toEqual([]);
    await expect(fetchIntegrationStatus("host/id")).resolves.toEqual({
      state: "idle",
    });
    expect(http.calls[0]?.[0]).toContain("/api/v1/integrations");
    expect(http.calls[1]?.[0]).toContain(
      "/api/v1/integrations/host%2Fid/status",
    );
  });

  it("sends create, update, test, and delete requests", async () => {
    http
      .respond(jsonResponse({ id: "host" }))
      .respond(jsonResponse({ id: "host" }))
      .respond(jsonResponse({ ok: true }))
      .respond(jsonResponse({ ok: true }));

    await createIntegration({
      type: "moonraker",
      name: "Host",
      config: { base_url: "http://printer" },
    });
    await updateIntegration("host/id", { name: "Renamed" });
    await testIntegration("host/id");
    await deleteIntegration("host/id");

    expect(http.requestJson(0)).toEqual({
      type: "moonraker",
      name: "Host",
      config: { base_url: "http://printer" },
    });
    expect(http.requestJson(1)).toEqual({ name: "Renamed" });
    expect(http.calls[2]?.[0]).toContain("/api/v1/integrations/host%2Fid/test");
    expect(http.calls[3]?.[0]).toContain("/api/v1/integrations/host%2Fid");
  });
});
