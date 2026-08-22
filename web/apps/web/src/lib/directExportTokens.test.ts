import { describe, expect, it } from "vitest";
import { parseAcceptedPlateWorkspace } from "@print-partner/contracts";
import { directExportTokensFromWorkspace } from "./directExportTokens";

const digest = "a".repeat(64);
const token = `ppu_${"b".repeat(32)}`;
const second = `ppu_${"c".repeat(32)}`;
const plateId = `plate_${"d".repeat(32)}`;
const basis = {
  profile_id: 7,
  plan_version: 3,
  plan_revision_id: 11,
  plan_revision_digest: digest,
  required_unit_mapping_digest: digest,
};
const printer = {
  id: "printer-one",
  name: "Printer One",
  model: "Model One",
  bed_width_um: 250_000,
  bed_depth_um: 210_000,
  bed_height_um: 200_000,
  margin_um: 4_000,
};
const setupUnit = {
  token,
  object_name: `bracket__${token}`,
  filename: "bracket.stl",
  source_layer: "Hardware",
  role: "primary",
  filament_color_id: null,
};

describe("directExportTokensFromWorkspace", () => {
  it("uses every Required unit before Plates are published", () => {
    const workspace = parseAcceptedPlateWorkspace({
      kind: "setup",
      basis,
      expected_plate_revision_id: null,
      printers: [printer],
      units: [
        setupUnit,
        { ...setupUnit, token: second, object_name: `clip__${second}`, filename: "clip.stl" },
      ],
    });
    expect(directExportTokensFromWorkspace(workspace)).toEqual([token, second]);
  });

  it("uses every placed unit after Plates are published", () => {
    const workspace = parseAcceptedPlateWorkspace({
      kind: "ready",
      basis,
      plate_revision_id: 19,
      plate_revision_number: 2,
      printers: [printer],
      plates: [{
        plate_id: plateId,
        ordinal: 1,
        printer,
        units: [{
          ...setupUnit,
          x_um: 4_000,
          y_um: 4_000,
          width_um: 30_000,
          depth_um: 20_000,
          height_um: 10_000,
        }],
      }],
    });
    expect(directExportTokensFromWorkspace(workspace)).toEqual([token]);
  });

  it("returns no tokens when the Plan has no Required units", () => {
    expect(directExportTokensFromWorkspace(parseAcceptedPlateWorkspace({ kind: "empty_plan" }))).toEqual([]);
    expect(directExportTokensFromWorkspace(undefined)).toEqual([]);
  });
});
