import type { PrinterStoredFile } from "@print-partner/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import { setEngineUnauthorizedHandler } from "../contractRequest";
import { EngineHttpError } from "../engineTransport";
import {
  addPrinter,
  deletePrinter,
  fetchPrinterPresets,
  fetchPrinters,
  openPrinterStoredFile,
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

afterEach(() => {
  setEngineUnauthorizedHandler(null);
});

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

describe("stored printer file downloads", () => {
  const file: PrinterStoredFile = {
    kind: "file",
    path: "usb/plate.bgcode",
    name: "plate.bgcode",
    modified_at: "2026-09-04T12:00:00Z",
  };
  const interruptedMessage =
    "The printer file download was interrupted. Try again, or upload the file from your computer.";

  it("explains a connection failure before the response arrives", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("Failed to fetch")));

    await expect(openPrinterStoredFile({ printerId: "p1", file })).rejects.toThrow(
      interruptedMessage,
    );
  });

  it("explains an interrupted body after a successful response", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial print file"));
      },
      pull(controller) {
        controller.error(new TypeError("terminated"));
      },
    }));
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(response));

    expect(response.status).toBe(200);
    await expect(openPrinterStoredFile({ printerId: "p1", file })).rejects.toThrow(
      interruptedMessage,
    );
  });

  it("uses a readable fallback when the server fails without a problem body", async () => {
    http.respond(new Response("Internal Server Error", { status: 500 }));

    await expect(openPrinterStoredFile({ printerId: "p1", file })).rejects.toMatchObject({
      status: 500,
      message: "Could not download the printer file: 500",
    });
  });

  it.each([401, 502])("preserves the server's %s error and authentication handling", async (status) => {
    const unauthorized = vi.fn();
    setEngineUnauthorizedHandler(unauthorized);
    const body = { detail: "Printer file access is unavailable" };
    http.respond(jsonResponse(body, status));

    const result = openPrinterStoredFile({ printerId: "p1", file });

    await expect(result).rejects.toBeInstanceOf(EngineHttpError);
    await expect(result).rejects.toMatchObject({
      message: body.detail,
      status,
      body,
    });
    expect(unauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });

  it("returns the downloaded bytes and metadata without interpreting the file", async () => {
    http.respond(new Response("not a valid sliced file", {
      headers: { "Content-Type": "application/octet-stream" },
    }));

    const downloaded = await openPrinterStoredFile({ printerId: "printer/id", file });

    expect(await downloaded.text()).toBe("not a valid sliced file");
    expect(downloaded.name).toBe(file.name);
    expect(downloaded.type).toBe("application/octet-stream");
    expect(downloaded.lastModified).toBe(Date.parse(file.modified_at ?? ""));
    expect(http.request().url).toBe("/printers/printer%2Fid/files/content?path=usb%2Fplate.bgcode");
    expect(http.calls[0]?.[1]?.credentials).toBe("include");
  });
});
