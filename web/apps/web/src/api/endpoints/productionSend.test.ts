import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  bambuConnectDownloadUrl,
  startBambuConnectHandoff,
  startPrinterUpload,
} from "./productionSend";

const http = createEndpointTestHttp();

describe("production send endpoints", () => {

  it("stages Bambu Connect handoffs and builds download URLs", async () => {
    http.respond(jsonResponse({ handoff_id: "handoff", message: "ok" }));

    await startBambuConnectHandoff({
      file: new File(["3mf"], "plate.3mf"),
      printer_id: "bambu",
      launch: false,
      profile_id: 7,
    });

    const form = http.requestForm();
    expect(http.calls[0]?.[0]).toContain("/bambu-connect/handoff");
    expect(form.get("printer_id")).toBe("bambu");
    expect(form.get("launch")).toBe("0");
    expect(form.get("profile_id")).toBe("7");
    expect(Array.from(form.keys())).toEqual(["printer_id", "launch", "profile_id", "file"]);
    expect(bambuConnectDownloadUrl("/bambu-connect/handoff/handoff/file?profile_id=7")).toContain(
      "/bambu-connect/handoff/handoff/file?profile_id=7",
    );
  });

  it("starts printer uploads and validates returned job ids", async () => {
    http.respond(jsonResponse({ job_id: " job-1 " }));

    await expect(
      startPrinterUpload({
        file: new File(["gcode"], "plate.gcode"),
        printer_id: "printer",
        start: false,
        profile_id: 7,
        unlabeled_names: ["unknown"],
      }),
    ).resolves.toBe("job-1");

    const form = http.requestForm();
    expect(http.calls[0]?.[0]).toContain("/jobs/printer-upload");
    expect(form.get("start")).toBe("0");
    expect(form.get("unlabeled_names")).toBe(JSON.stringify(["unknown"]));
  });

  it("surfaces upload errors", async () => {
    http.respond(jsonResponse({ detail: "No printer" }, 400));

    await expect(
      startPrinterUpload({
        file: new File(["gcode"], "plate.gcode"),
        printer_id: "missing",
      }),
    ).rejects.toThrow("No printer");
  });
});
