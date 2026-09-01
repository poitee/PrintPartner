import { describe, expect, it } from "vitest";
import type { IntegrationSummary } from "../api/endpoints/integrations";
import type { PrinterMachine, PrinterPreset } from "../api/endpoints/printers";
import {
  DEFAULT_PRINTER_HOST_URLS,
  PRINTER_HOST_TYPE_LABELS,
  SLICER_OVERRIDE_LABELS,
  SLICER_OVERRIDES,
  isPrinterHostType,
  linkedPrinters,
  orphanPrinters,
  parsePrinterDetailsDraft,
  pickDefaultPresetId,
  printerDetailsDraft,
  printerHostConnectionReady,
  printerSettingsCanAdd,
  statusPillLabel,
} from "./printerSettingsModel";

function preset(id: string, name: string): PrinterPreset {
  return {
    id,
    name,
    bed_width_mm: 250,
    bed_depth_mm: 220,
    bed_height_mm: 270,
    max_filament_slots: 1,
  };
}

const printer = {
  id: "printer-one",
  name: "Core One",
  model: "Prusa Core One",
  bed_width_mm: 250,
  bed_depth_mm: 220,
  bed_height_mm: 270,
  margin_mm: 5,
  max_filament_slots: 1,
  preset_id: "preset-core-one",
  integration_id: null,
  device_id: null,
  loaded_filaments: [],
  preferred_slicer: null,
} satisfies PrinterMachine;

describe("printer settings model", () => {
  it("round-trips printer details through the editable draft", () => {
    const draft = printerDetailsDraft(printer);

    expect(draft).toMatchObject({
      name: "Core One",
      bedWidth: "250",
      presetId: "preset-core-one",
    });
    expect(parsePrinterDetailsDraft(draft)).toEqual({
      name: "Core One",
      model: "Prusa Core One",
      bed_width_mm: 250,
      bed_depth_mm: 220,
      bed_height_mm: 270,
      margin_mm: 5,
      max_filament_slots: 1,
      preset_id: "preset-core-one",
    });
  });

  it("rejects invalid geometry", () => {
    expect(() =>
      parsePrinterDetailsDraft({
        ...printerDetailsDraft(printer),
        margin: "200",
      }),
    ).toThrow("Bed margin must be less than half of bed width and depth.");
  });

  it("formats status pills", () => {
    expect(statusPillLabel({ state: "printing", progress: 42.4 })).toBe("Printing 42%");
    expect(statusPillLabel({ state: "offline", message: "No route" })).toBe("Offline");
  });

  it("validates host types and exposes host defaults", () => {
    expect(isPrinterHostType("moonraker")).toBe(true);
    expect(isPrinterHostType("octoprint")).toBe(false);
    expect(DEFAULT_PRINTER_HOST_URLS.moonraker).toContain(":7125");
    expect(PRINTER_HOST_TYPE_LABELS.bambu).toBe("Bambu");
  });

  it("exposes slicer override labels", () => {
    expect(SLICER_OVERRIDES).toEqual(["orca", "prusa", "bambu"]);
    expect(SLICER_OVERRIDE_LABELS).toMatchObject({
      orca: "OrcaSlicer",
      prusa: "PrusaSlicer",
      bambu: "BambuStudio",
    });
  });

  it("picks the preferred preset when available", () => {
    expect(
      pickDefaultPresetId(
        [preset("a", "A"), preset("preferred", "Preferred")],
        "preferred",
      ),
    ).toBe("preferred");
    expect(pickDefaultPresetId([preset("a", "A")], "missing")).toBe("a");
  });

  it("decides when a printer can be added", () => {
    expect(
      printerSettingsCanAdd({
        engineReady: true,
        busy: false,
        name: " Shop Printer ",
        presetId: "preset-a",
        customPresetId: "custom",
        customWidth: "",
        customDepth: "",
        customHeight: "",
      }),
    ).toBe(true);
    expect(
      printerSettingsCanAdd({
        engineReady: true,
        busy: false,
        name: "Shop Printer",
        presetId: "custom",
        customPresetId: "custom",
        customWidth: "250",
        customDepth: "220",
        customHeight: "270",
      }),
    ).toBe(true);
    expect(
      printerSettingsCanAdd({
        engineReady: true,
        busy: false,
        name: "Shop Printer",
        presetId: "custom",
        customPresetId: "custom",
        customWidth: "0",
        customDepth: "220",
        customHeight: "270",
      }),
    ).toBe(false);
  });

  it("decides when host connection details are ready", () => {
    expect(
      printerHostConnectionReady({
        hostType: "moonraker",
        url: "http://printer.local",
        password: "",
        bambuHost: "",
        accessCode: "",
        serial: "",
      }),
    ).toBe(true);
    expect(
      printerHostConnectionReady({
        hostType: "prusalink",
        url: "http://printer.local",
        password: "secret",
        bambuHost: "",
        accessCode: "",
        serial: "",
      }),
    ).toBe(true);
    expect(
      printerHostConnectionReady({
        hostType: "bambu",
        url: "",
        password: "",
        bambuHost: "192.168.1.60",
        accessCode: "12345678",
        serial: "ABC123",
      }),
    ).toBe(true);
  });

  it("splits linked and orphan printers by printer host integrations", () => {
    const linked = { ...printer, integration_id: "host-1" } satisfies PrinterMachine;
    const orphan = { ...printer, id: "orphan", integration_id: null } satisfies PrinterMachine;
    const stale = { ...printer, id: "stale", integration_id: "missing" } satisfies PrinterMachine;
    const hosts = new Map<string, IntegrationSummary>([
      [
        "host-1",
        {
          id: "host-1",
          type: "moonraker",
          name: "Host",
          config: {},
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      [
        "spools",
        {
          id: "spools",
          // A real integration that is not a printer host, so it must never
          // link a printer.
          type: "spoolman",
          name: "Spoolman",
          config: {},
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    ]);

    expect(linkedPrinters([linked, orphan, stale], hosts)).toEqual([linked]);
    expect(orphanPrinters([linked, orphan, stale], hosts)).toEqual([orphan, stale]);
  });
});
