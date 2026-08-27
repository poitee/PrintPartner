import { describe, expect, it } from "vitest";
import type { IntegrationSummary } from "../api/endpoints/integrations";
import type { PrinterMachine } from "../api/endpoints/printers";
import {
  isAllowedBambuConnectFile,
  isAllowedGcode,
  partitionPrinterSendFleet,
  printerSendStatusLabel,
  printerSendStatusVariant,
  resolveStickyPrinterId,
} from "./printerSendModel";

function printer(id: string, integrationId: string | null = null): PrinterMachine {
  return {
    id,
    name: id,
    model: "Model",
    bed_width_mm: 250,
    bed_depth_mm: 250,
    bed_height_mm: 250,
    margin_mm: 5,
    max_filament_slots: 1,
    loaded_filaments: [],
    integration_id: integrationId,
  };
}

function integration(
  id: string,
  type: string,
  enabled: boolean | undefined = true,
): IntegrationSummary {
  return {
    id,
    type,
    name: id,
    config: enabled === undefined ? {} : { enabled },
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
  };
}

describe("printer send model", () => {
  it("allows only supported sliced files", () => {
    expect(isAllowedGcode("plate.gcode")).toBe(true);
    expect(isAllowedGcode("plate.bgcode")).toBe(true);
    expect(isAllowedGcode("plate.3mf")).toBe(false);
    expect(isAllowedBambuConnectFile("plate.gcode.3mf")).toBe(true);
    expect(isAllowedBambuConnectFile("plate.3mf")).toBe(true);
    expect(isAllowedBambuConnectFile("plate.stl")).toBe(false);
  });

  it("partitions linked printers by send capability", () => {
    const result = partitionPrinterSendFleet(
      [
        printer("klipper", "host-one"),
        printer("bambu", "host-two"),
        printer("disabled", "host-three"),
        printer("missing", "host-missing"),
      ],
      [
        integration("host-one", "moonraker"),
        integration("host-two", "bambu"),
        integration("host-three", "prusalink", false),
      ],
    );

    expect(result.sendPrinters.map((row) => row.id)).toEqual(["klipper"]);
    expect(result.bambuPrinters.map((row) => row.id)).toEqual(["bambu"]);
    expect(result.hostTypeByPrinterId).toEqual({ klipper: "moonraker", bambu: "bambu" });
  });

  it("formats status labels and variants", () => {
    expect(printerSendStatusLabel({ state: "printing", progress: 88.6 })).toBe("Printing 89%");
    expect(printerSendStatusLabel({ state: "idle" })).toBe("Idle");
    expect(printerSendStatusVariant({ state: "paused" })).toBe("warning");
    expect(printerSendStatusVariant({ state: "offline" })).toBe("error");
  });

  it("keeps the current printer before falling back to sticky or first", () => {
    const printers = [printer("one"), printer("two")];

    expect(resolveStickyPrinterId(printers, "one", "two")).toBe("two");
    expect(resolveStickyPrinterId(printers, "one", "missing")).toBe("one");
    expect(resolveStickyPrinterId(printers, "missing", "")).toBe("one");
    expect(resolveStickyPrinterId([], "one", "two")).toBe("");
  });
});
