import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  fetchAppUpdateCheck,
  fetchHealth,
  fetchLegalDocument,
  fetchWorkflowGuide,
} from "./help";

const http = createEndpointTestHttp();

describe("help endpoints", () => {
  it("fetches health", async () => {
    http.respond(jsonResponse({ ok: true, multi_user: false }));

    await expect(fetchHealth()).resolves.toEqual({
      ok: true,
      multi_user: false,
    });
    expect(http.calls[0]?.[0]).toContain("/health");
  });

  it("fetches update checks with optional refresh", async () => {
    http.respond(jsonResponse({ current_version: "1", latest_version: "2" }));

    await fetchAppUpdateCheck(true);

    expect(http.calls[0]?.[0]).toContain("/settings/update-check?refresh=1");
  });

  it("fetches legal and workflow text", async () => {
    http
      .respond(new Response("license text", { status: 200 }))
      .respond(new Response("workflow text", { status: 200 }));

    await expect(fetchLegalDocument("license")).resolves.toBe("license text");
    await expect(fetchWorkflowGuide()).resolves.toBe("workflow text");
  });
});
