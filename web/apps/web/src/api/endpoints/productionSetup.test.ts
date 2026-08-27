import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  fetchProductionSetup,
  fetchProfileLibrary,
  saveProductionSetup,
} from "./productionSetup";

const http = createEndpointTestHttp();

describe("production setup endpoints", () => {
  it("fetches and saves production setup", async () => {
    http
      .respond(jsonResponse({ profile_id: 7 }))
      .respond(jsonResponse({ profile_id: 7 }));

    const setup = {
      preferred_slicer_instance_id: "slicer",
      selection: { mode: "all_incomplete" as const },
      printer_assignments: [{ token: "unit", printer_id: "printer" }],
      rules: [],
    };

    await fetchProductionSetup(7);
    await saveProductionSetup(7, setup);

    expect(http.calls[0]?.[0]).toContain("/plans/7/production-setup");
    expect(http.requestJson(1)).toEqual(setup);
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
