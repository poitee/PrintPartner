import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  applyRoleColorsToParts,
  createCustomFilament,
  deleteCustomFilament,
  fetchCustomFilaments,
  fetchFilamentCatalog,
  fetchRoleFilaments,
  fetchSpoolmanDefaultSettings,
  fetchSpoolmanSpools,
  saveRoleFilament,
  saveSpoolmanDefaultIntegration,
} from "./filaments";

const http = createEndpointTestHttp();

describe("filament endpoints", () => {
  it("fetches filament catalog, custom filaments, role filaments, defaults, and spools", async () => {
    http
      .respond(
        jsonResponse({
          synced_at: "now",
          source: "local",
          status: "ok",
          colors: [],
          custom_colors: [],
        }),
      )
      .respond(jsonResponse({ filaments: [] }))
      .respond(jsonResponse({ roles: [] }))
      .respond(jsonResponse({ integration_id: "spoolman" }))
      .respond(jsonResponse({ spools: [] }));

    await expect(fetchFilamentCatalog()).resolves.toMatchObject({
      status: "ok",
    });
    await expect(fetchCustomFilaments()).resolves.toEqual([]);
    await expect(fetchRoleFilaments(7)).resolves.toEqual([]);
    await expect(fetchSpoolmanDefaultSettings()).resolves.toEqual({
      integration_id: "spoolman",
    });
    await expect(fetchSpoolmanSpools("int/id")).resolves.toEqual([]);
    expect(http.calls[4]?.[0]).toContain(
      "/api/v1/integrations/int%2Fid/spoolman/spools",
    );
  });

  it("sends filament mutation payloads", async () => {
    http
      .respond(jsonResponse({ integration_id: null }))
      .respond(jsonResponse({ id: "custom" }))
      .respond(jsonResponse({ ok: true }))
      .respond(jsonResponse({ updated: 1, thumbnails_cleared: 0, roles: [] }))
      .respond(jsonResponse({ updated: 2, thumbnails_cleared: 2, roles: [] }));

    await saveSpoolmanDefaultIntegration(null);
    await createCustomFilament({
      display_name: "Red",
      hex: "#ff0000",
      product_line: "PLA",
    });
    await deleteCustomFilament("custom/id");
    await saveRoleFilament(7, {
      role: "accent",
      filament_custom_hex: "#ff0000",
    });
    await applyRoleColorsToParts(7, { refresh_thumbnails: false });

    expect(http.requestJson(0)).toEqual({ integration_id: null });
    expect(http.requestJson(1)).toEqual({
      display_name: "Red",
      hex: "#ff0000",
      product_line: "PLA",
    });
    expect(http.calls[2]?.[0]).toContain("/filaments/custom/custom%2Fid");
    expect(http.requestJson(3)).toEqual({
      role: "accent",
      filament_custom_hex: "#ff0000",
    });
    expect(http.requestJson(4)).toEqual({ refresh_thumbnails: false });
  });
});
