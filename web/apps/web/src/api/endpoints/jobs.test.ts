import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  fetchJob,
  startExportStlPack,
} from "./jobs";

const http = createEndpointTestHttp();

describe("job endpoints", () => {

  it("sends chosen Required units, and omits them when nothing is chosen", async () => {
    http
      .respond(jsonResponse({ job_id: "chosen" }))
      .respond(jsonResponse({ job_id: "everything" }));

    const token = `ppu_${"a".repeat(32)}`;
    await expect(startExportStlPack(7, { unit_tokens: [token] })).resolves.toBe("chosen");
    await expect(startExportStlPack(7, { unit_tokens: [] })).resolves.toBe("everything");

    expect(http.requestJson(0)).toEqual({
      profile_id: 7,
      missing_only: false,
      group_by: "color_dir",
      unit_tokens: [token],
    });
    // An empty choice means the whole Build, which is what every caller before
    // the route choice sent, so the field is absent rather than empty.
    expect(http.requestJson(1)).toEqual({
      profile_id: 7,
      missing_only: false,
      group_by: "color_dir",
    });
  });

  it("fetches a job snapshot", async () => {
    http.respond(jsonResponse({ id: "job", status: "done" }));

    await expect(fetchJob("job/id")).resolves.toMatchObject({
      id: "job",
      status: "done",
    });
    expect(http.calls[0]?.[0]).toContain("/jobs/job/id");
  });
});
