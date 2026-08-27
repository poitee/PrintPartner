import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  bambuConnectDownloadUrl,
  cancelPrinterSendQueueItem,
  dispatchPrinterSendQueueItem,
  drainPrinterSendQueue,
  enqueuePrinterSend,
  fetchPrinterQueueSuggestions,
  fetchPrinterSendQueue,
  startBambuConnectHandoff,
  startPrinterUpload,
} from "./productionSend";

const http = createEndpointTestHttp();

describe("production send endpoints", () => {
  it("fetches, dispatches, drains, cancels, and suggests queue items", async () => {
    http
      .respond(jsonResponse({ items: [] }))
      .respond(jsonResponse({ item: { id: "item" }, job_id: "job" }))
      .respond(jsonResponse({ results: [{ item_id: "item", job_id: "job" }] }))
      .respond(jsonResponse({ item: { id: "item" } }))
      .respond(jsonResponse({ suggestions: [] }));

    await fetchPrinterSendQueue({ active: true });
    await dispatchPrinterSendQueueItem({ id: "item/id", force: true });
    await drainPrinterSendQueue({ printer_id: "printer" });
    await cancelPrinterSendQueueItem("item/id");
    await fetchPrinterQueueSuggestions({
      idle_integration_ids: ["host/a", "host/b"],
    });

    expect(http.calls[0]?.[0]).toContain("/printer-send-queue?active=1");
    expect(http.calls[1]?.[0]).toContain(
      "/printer-send-queue/item%2Fid/dispatch",
    );
    expect(http.requestJson(1)).toEqual({ force: true });
    expect(http.requestJson(2)).toEqual({ printer_id: "printer" });
    expect(http.calls[3]?.[0]).toContain("/printer-send-queue/item%2Fid");
    expect(http.calls[4]?.[0]).toContain(
      "idle_integration_ids=host%2Fa%2Chost%2Fb",
    );
  });

  it("does not hit the network for empty queue suggestion input", async () => {
    await expect(
      fetchPrinterQueueSuggestions({ idle_integration_ids: [] }),
    ).resolves.toEqual({ suggestions: [] });
    expect(http.calls).toHaveLength(0);
  });

  it("queues multipart printer sends", async () => {
    http.respond(jsonResponse({ item: { id: "item" } }));

    await enqueuePrinterSend({
      file: new File(["gcode"], "plate.gcode"),
      printer_id: "printer",
      start: true,
      wait_for_idle: false,
      match: "compatible",
      profile_id: 7,
      checkoff_units: [{ part_id: 1, unit_index: 0 }],
    });

    const form = http.requestForm();
    expect(http.calls[0]?.[0]).toContain("/printer-send-queue");
    expect(form.get("printer_id")).toBe("printer");
    expect(form.get("start")).toBe("1");
    expect(form.get("wait_for_idle")).toBe("0");
    expect(form.get("match")).toBe("compatible");
    expect(form.get("profile_id")).toBe("7");
    expect(form.get("checkoff_units")).toBe(
      JSON.stringify([{ part_id: 1, unit_index: 0 }]),
    );
  });

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
    expect(bambuConnectDownloadUrl("/download/file")).toContain(
      "/download/file",
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
