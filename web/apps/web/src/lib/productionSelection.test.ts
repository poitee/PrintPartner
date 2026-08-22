import { describe, expect, it } from "vitest";
import { parseAcceptedPlateWorkspace } from "@print-partner/contracts";
import {
  clearProductionSelectionGroup,
  initialMissingSelection,
  initialProductionSelection,
  productionSelectableUnits,
  selectedProductionTokens,
  toggleProductionUnit,
} from "./productionSelection";

const digest = "a".repeat(64);
const token = `ppu_${"b".repeat(32)}`;
const second = `ppu_${"c".repeat(32)}`;
const third = `ppu_${"d".repeat(32)}`;
const plateId = `plate_${"e".repeat(32)}`;
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

function setupUnit(id: string, filename: string, extras: Record<string, unknown> = {}) {
  return {
    token: id,
    object_name: `${filename.replace(/\.stl$/i, "")}__${id}`,
    filename,
    source_layer: extras.source_layer ?? "Hardware",
    role: extras.role ?? "primary",
    filament_color_id: null,
    ...extras,
  };
}

describe("productionSelection", () => {
  it("starts Prepare missing parts with every incomplete Required unit selected", () => {
    const workspace = parseAcceptedPlateWorkspace({
      kind: "setup",
      basis,
      expected_plate_revision_id: null,
      printers: [printer],
      units: [
        setupUnit(token, "bracket.stl"),
        setupUnit(second, "clip.stl", { completed: true, role: "accent" }),
        setupUnit(third, "spacer.stl", { source_layer: "Electronics" }),
      ],
    });
    const units = productionSelectableUnits(workspace);
    expect(units.map((unit) => [unit.token, unit.completed])).toEqual([
      [token, false],
      [second, true],
      [third, false],
    ]);
    expect([...initialMissingSelection(units)]).toEqual([token, third]);
    expect([...initialProductionSelection(units, "missing")]).toEqual([token, third]);
    expect([...initialProductionSelection(units, null)]).toEqual([token, second, third]);
    expect(selectedProductionTokens(units, initialMissingSelection(units))).toEqual([token, third]);
  });

  it("lets the user clear one unit or a Source-layer group before Direct export", () => {
    const workspace = parseAcceptedPlateWorkspace({
      kind: "setup",
      basis,
      expected_plate_revision_id: null,
      printers: [printer],
      units: [
        setupUnit(token, "bracket.stl"),
        setupUnit(second, "clip.stl", { source_layer: "Electronics" }),
        setupUnit(third, "spacer.stl", { source_layer: "Electronics" }),
      ],
    });
    const units = productionSelectableUnits(workspace);
    const missing = initialMissingSelection(units);
    const withoutOne = toggleProductionUnit(missing, units[0].token);
    expect([...withoutOne]).toEqual([second, third]);
    expect([...clearProductionSelectionGroup(withoutOne, units, "source_layer", "Electronics")]).toEqual([]);
  });

  it("keeps unplaced Required units selectable in a ready workspace", () => {
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
          ...setupUnit(token, "bracket.stl"),
          x_um: 4_000,
          y_um: 4_000,
          width_um: 30_000,
          depth_um: 20_000,
          height_um: 10_000,
        }],
      }],
      unplaced: [{
        ...setupUnit(second, "clip.stl", { source_layer: "Electronics" }),
        plate_id: plateId,
        printer_id: printer.id,
        width_um: 30_000,
        depth_um: 20_000,
        height_um: 10_000,
      }],
      unassigned: [setupUnit(third, "spacer.stl")],
    });

    expect(productionSelectableUnits(workspace).map((unit) => unit.token)).toEqual([
      token,
      second,
      third,
    ]);
  });
});
