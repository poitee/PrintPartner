import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  archiveProfile,
  createProfile,
  deleteProfile,
  duplicateProfile,
  fetchProfiles,
  patchPart,
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
