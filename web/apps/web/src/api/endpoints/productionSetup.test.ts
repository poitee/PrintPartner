import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  applyProductionSetupCommand,
  fetchProductionSetup,
  fetchProfileLibrary,
} from "./productionSetup";

const http = createEndpointTestHttp();

describe("production setup endpoints", () => {
  it("fetches production setup and applies one command", async () => {
    http
      .respond(jsonResponse({ profile_id: 7 }))
      .respond(jsonResponse({ profile_id: 7 }));

    const command = { kind: "set_route", route: "plates" } as const;

    await fetchProductionSetup(7);
    await applyProductionSetupCommand(7, command);

    expect(http.calls[0]?.[0]).toContain("/plans/7/production-setup");
    expect(http.request(1).method).toBe("PATCH");
    expect(http.requestJson(1)).toEqual(command);
  });

  it("fetches the synced slicer profile library", async () => {
    http.respond(
      jsonResponse({ profiles: [{ id: 1, kind: "printer", name: "Printer" }] }),
    );

    await expect(fetchProfileLibrary()).resolves.toEqual([
      { id: 1, kind: "printer", name: "Printer" },
    ]);
    expect(http.calls[0]?.[0]).toContain("/profile-library");
  });
});
