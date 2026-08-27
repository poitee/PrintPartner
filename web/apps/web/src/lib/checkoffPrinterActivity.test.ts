import { describe, expect, it } from "vitest";
import type { UnattributedPrint } from "@print-partner/contracts";
import type { PrinterCheckoffLink } from "../api/endpoints/checkoff";
import type { ReviewPart } from "../api/endpoints/planManifests";
import { buildCheckoffPrinterActivityParts } from "./checkoffPrinterActivity";

function part(id: number, filename: string): ReviewPart {
  return {
    id,
    match_key: filename,
    relative_path: filename,
    filename,
    source_layer: null,
    status: "included",
    role: null,
    requirement: null,
    option_group_id: null,
    included: true,
    filament_color_id: null,
    quantity_auto: 1,
    quantity_override: null,
    quantity_effective: 1,
    printed_count: 0,
    print_units: [false],
    missing: true,
    filament_display: "Default",
  };
}

function link(input: {
  state: "watching" | "awaiting_verify";
  hostName: string;
  partId: number;
}): PrinterCheckoffLink {
  return {
    id: `${input.state}-${input.partId}`,
    profile_id: 7,
    integration_id: "printer-one",
    printer_id: "printer-one",
    host_name: input.hostName,
    filename: "plate.bgcode",
    units: [{ part_id: input.partId, unit_index: 0 }],
    state: input.state,
    saw_active: true,
    started: true,
    created_at: "2026-08-25T00:00:00.000Z",
  };
}

const unattributed = {
  id: "unattributed-one",
  integration_id: "printer-one",
  printer_id: "printer-one",
  host_name: "Core One",
  filename: "external.bgcode",
  completed_at: "2026-08-25T00:00:00.000Z",
  gcode_objects: ["gear.stl"],
  candidates: [
    {
      stl_basename: "gear.stl",
      copy_count: 1,
      matching_filenames: ["gear.stl"],
    },
  ],
} satisfies UnattributedPrint;

describe("buildCheckoffPrinterActivityParts", () => {
  it("derives printing, awaiting verify, and selected-file claim hints", () => {
    const activity = buildCheckoffPrinterActivityParts({
      watchingLinks: [link({ state: "watching", hostName: "Trident", partId: 1 })],
      awaitingLinks: [link({ state: "awaiting_verify", hostName: "Core One", partId: 2 })],
      unattributedPrints: [unattributed],
      includedParts: [part(1, "frame.stl"), part(2, "idler.stl"), part(3, "gear.stl")],
    });

    expect(activity.printingPartIds.get(1)).toBe("Trident");
    expect(activity.awaitingPartIds.get(2)).toBe("Core One");
    expect(activity.suggestedPartIds.get(3)).toEqual({
      hostName: "Core One",
      printId: "unattributed-one",
      filename: "external.bgcode",
      stlBasename: "gear.stl",
    });
  });
});
