import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  addPrinter,
  deletePrinter,
  fetchPrinterPresets,
  fetchPrinters,
  savePrinterFleet,
  updatePrinterDetails,
  updatePrinterSlicer,
  type PrinterMachine,
} from "./printers";

function printer(id = "p1"): PrinterMachine {
  return {
    id,
    name: "Printer",
    model: "Model",
    bed_width_mm: 250,
    bed_depth_mm: 250,
    bed_height_mm: 250,
    margin_mm: 5,
    max_filament_slots: 1,
    loaded_filaments: [],
  };
}

const http = createEndpointTestHttp();

describe("printer endpoints", () => {
  it("fetches printers and presets", async () => {
    http
      .respond(jsonResponse({ presets: [{ id: "preset", name: "Preset" }] }))
      .respond(jsonResponse({ printers: [printer()] }));

    await expect(fetchPrinterPresets()).resolves.toEqual([
      { id: "preset", name: "Preset" },
    ]);
    await expect(fetchPrinters()).resolves.toHaveLength(1);
  });

  it("saves and creates printers", async () => {
    http
      .respond(jsonResponse({ printers: [printer()] }))
      .respond(jsonResponse(printer("p2")));

    await savePrinterFleet([printer()]);
    await addPrinter({ kind: "preset", name: "New", preset_id: "preset" });

    expect(http.requestJson(0)).toEqual({ printers: [printer()] });
    expect(http.requestJson(1)).toEqual({ name: "New", preset_id: "preset" });
  });

  it("updates details and slicer preferences", async () => {
    http.respond(jsonResponse(printer())).respond(jsonResponse(printer()));

    await updatePrinterDetails("printer/id", {
      name: "Renamed",
      model: "Model",
      bed_width_mm: 250,
      bed_depth_mm: 250,
      bed_height_mm: null,
      margin_mm: 5,
      max_filament_slots: 4,
      preset_id: null,
    });
    await updatePrinterSlicer("printer-1", "orca");

    expect(http.calls[0]?.[0]).toContain("/printers/printer%2Fid/details");
    expect(http.requestJson(0)).toMatchObject({
      name: "Renamed",
      preset_id: null,
    });
    expect(http.requestJson(1)).toEqual({ preferred_slicer: "orca" });
  });

  it("deletes printers", async () => {
    http.respond(jsonResponse({ ok: true }));

    await deletePrinter("p1");

    expect(http.calls[0]?.[0]).toContain("/printers/p1");
  });
});
