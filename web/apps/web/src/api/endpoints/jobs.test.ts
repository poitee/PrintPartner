import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  fetchJob,
  startExportChecklistHtml,
  startExportKitBundle,
  startExportStlPack,
  startSync,
} from "./jobs";

const http = createEndpointTestHttp();

describe("job endpoints", () => {
  it("starts sync and export jobs", async () => {
    http
      .respond(jsonResponse({ job_id: "sync" }))
      .respond(jsonResponse({ job_id: "kit" }))
      .respond(jsonResponse({ job_id: "stl" }))
      .respond(jsonResponse({ job_id: "checklist" }));

    await expect(startSync([1, 2])).resolves.toBe("sync");
    await expect(startExportKitBundle(7, true)).resolves.toBe("kit");
    await expect(
      startExportStlPack(7, { missing_only: true, group_by: "color" }),
    ).resolves.toBe("stl");
    await expect(startExportChecklistHtml(7)).resolves.toBe("checklist");

    expect(http.requestJson(0)).toEqual({ project_ids: [1, 2] });
    expect(http.requestJson(1)).toEqual({
      profile_id: 7,
      include_print_progress: true,
    });
    expect(http.requestJson(2)).toEqual({
      profile_id: 7,
      missing_only: true,
      group_by: "color",
    });
    expect(http.requestJson(3)).toEqual({ profile_id: 7 });
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
