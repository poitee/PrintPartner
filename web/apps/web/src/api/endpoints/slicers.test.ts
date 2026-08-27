import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  createSlicerInstance,
  deleteSlicerInstance,
  fetchSlicerDockerLogs,
  fetchSlicerDockerStatus,
  fetchSlicerInstances,
  fetchSlicerProfileOptions,
  pullSlicerDocker,
  seedDefaultSlicerInstances,
  startSlicerDocker,
  stopSlicerDocker,
  updateSlicerInstance,
} from "./slicers";

const http = createEndpointTestHttp();

describe("slicer endpoints", () => {
  it("fetches options and instances", async () => {
    http
      .respond(jsonResponse({ printers: [], filaments: [], processes: [] }))
      .respond(jsonResponse({ instances: [] }));

    await expect(fetchSlicerProfileOptions()).resolves.toEqual({
      printers: [],
      filaments: [],
      processes: [],
    });
    await expect(fetchSlicerInstances()).resolves.toEqual([]);
  });

  it("creates, updates, deletes, and seeds instances", async () => {
    http
      .respond(jsonResponse({ id: "slicer" }))
      .respond(jsonResponse({ id: "slicer" }))
      .respond(jsonResponse({ ok: true }))
      .respond(jsonResponse({ inserted: 2, instances: [] }));

    await createSlicerInstance({
      name: "Orca",
      kind: "orca",
      dialect: "orca_json",
    });
    await updateSlicerInstance("slicer/id", { enabled: false });
    await deleteSlicerInstance("slicer/id");
    await seedDefaultSlicerInstances();

    expect(http.requestJson(0)).toEqual({
      name: "Orca",
      kind: "orca",
      dialect: "orca_json",
    });
    expect(http.calls[1]?.[0]).toContain("/slicer-instances/slicer%2Fid");
    expect(http.requestJson(1)).toEqual({ enabled: false });
    expect(http.calls[2]?.[0]).toContain("/slicer-instances/slicer%2Fid");
    expect(http.calls[3]?.[0]).toContain("/slicer-instances/seed-defaults");
  });

  it("controls Docker helpers", async () => {
    const status = {
      instance: { id: "slicer" },
      status: { state: "idle", message: null, container_id: null },
    };
    http
      .respond(jsonResponse(status))
      .respond(jsonResponse(status))
      .respond(jsonResponse(status))
      .respond(jsonResponse(status))
      .respond(jsonResponse({ lines: ["one"] }));

    await fetchSlicerDockerStatus("slicer/id");
    await pullSlicerDocker("slicer/id");
    await startSlicerDocker("slicer/id");
    await stopSlicerDocker("slicer/id");
    await expect(fetchSlicerDockerLogs("slicer/id", 50)).resolves.toEqual({
      lines: ["one"],
    });

    expect(http.calls[0]?.[0]).toContain("/docker-status");
    expect(http.calls[1]?.[0]).toContain("/docker-pull");
    expect(http.calls[2]?.[0]).toContain("/docker-start");
    expect(http.calls[3]?.[0]).toContain("/docker-stop");
    expect(http.calls[4]?.[0]).toContain("/docker-logs?tail=50");
  });
});
