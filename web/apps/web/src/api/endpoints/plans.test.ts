import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  addProfileAddonLayer,
  archiveProfile,
  createProfile,
  deleteProfile,
  deleteProfileLayer,
  duplicateProfile,
  fetchProfileLayers,
  fetchProfilePartsGrouped,
  fetchProfiles,
  patchPart,
  replaceProfileLayer,
  setProfileBaseLayer,
  touchProfileLastUsed,
  updateProfile,
} from "./plans";

const http = createEndpointTestHttp();

describe("plan endpoints", () => {
  it("handles plan CRUD", async () => {
    http
      .respond(jsonResponse({ profiles: [] }))
      .respond(jsonResponse({ id: 1 }))
      .respond(jsonResponse({ id: 1, name: "Renamed" }))
      .respond(jsonResponse({ id: 1 }))
      .respond(jsonResponse({ id: 1 }))
      .respond(jsonResponse({ ok: true }))
      .respond(jsonResponse({ id: 2, layers: [] }));

    await fetchProfiles();
    await createProfile("Build", 9);
    await updateProfile(1, { name: "Renamed", special_request: null });
    await archiveProfile(1);
    await touchProfileLastUsed(1);
    await deleteProfile(1);
    await duplicateProfile(1, "Copy", { clearCheckoff: true });

    expect(http.requestJson(1)).toEqual({ name: "Build", base_project_id: 9 });
    expect(http.requestJson(2)).toEqual({
      name: "Renamed",
      special_request: null,
    });
    expect(http.requestJson(6)).toEqual({ name: "Copy", clear_checkoff: true });
  });

  it("handles plan layers and grouped parts", async () => {
    http
      .respond(jsonResponse({ layers: [] }))
      .respond(jsonResponse({ ok: true }))
      .respond(jsonResponse({ groups: [], total: 0 }))
      .respond(jsonResponse({ layers: [] }))
      .respond(jsonResponse({ layers: [] }))
      .respond(jsonResponse({ layers: [] }));

    await setProfileBaseLayer(7, 3);
    await deleteProfileLayer(7, 4);
    await fetchProfilePartsGrouped(7, " gear ");
    await replaceProfileLayer(7, 5, 6);
    await fetchProfileLayers(7);
    await addProfileAddonLayer(7, 8);

    expect(http.requestJson(0)).toEqual({ project_id: 3 });
    expect(http.calls[2]?.[0]).toContain("/plans/7/parts-grouped?query=gear");
    expect(http.requestJson(3)).toEqual({ project_id: 6 });
    expect(http.requestJson(5)).toEqual({ project_id: 8 });
  });

  it("patches part filament assignment", async () => {
    http.respond(jsonResponse({ id: 1 }));

    await patchPart(1, { filament_color_id: "red", spoolman_spool_id: null });

    expect(http.calls[0]?.[0]).toContain("/parts/1");
    expect(http.requestJson(0)).toEqual({
      filament_color_id: "red",
      spoolman_spool_id: null,
    });
  });
});
