import { describe, expect, it } from "vitest";
import {
  acceptedRevisionPartRow,
  partRow,
  planInputTrackingKind,
  type AcceptedRevisionPartRowModel,
  type PartDbRowModel,
} from "./part-row-model.js";

const basePart: PartDbRowModel = {
  id: 11,
  matchKey: "frame/a.stl",
  relativePath: "frame/a.stl",
  filename: "a.stl",
  sourceLayer: "base:kit",
  status: "ok",
  role: "frame",
  requirement: null,
  optionGroupId: null,
  included: true,
  filamentColorId: "black",
  filamentCustomHex: null,
  spoolmanSpoolId: "spoolman:1",
  quantityAuto: 2,
  quantityOverride: null,
  quantityEffective: 2,
};

describe("planInputTrackingKind", () => {
  it("only treats the explicit untracked value as untracked", () => {
    expect(planInputTrackingKind("untracked")).toBe("untracked");
    expect(planInputTrackingKind("revision")).toBe("revision");
    expect(planInputTrackingKind("anything else")).toBe("revision");
  });
});

describe("partRow", () => {
  it("maps stored parts to the API part row contract", () => {
    expect(partRow(basePart)).toEqual({
      id: 11,
      match_key: "frame/a.stl",
      relative_path: "frame/a.stl",
      filename: "a.stl",
      source_layer: "base:kit",
      status: "ok",
      role: "frame",
      requirement: null,
      option_group_id: null,
      included: true,
      filament_color_id: "black",
      filament_custom_hex: null,
      spoolman_spool_id: "spoolman:1",
      filament_display: "",
      filament_hex: null,
      quantity_auto: 2,
      quantity_override: null,
      quantity_effective: 2,
    });
  });
});

describe("acceptedRevisionPartRow", () => {
  const acceptedPart: AcceptedRevisionPartRowModel = {
    ...basePart,
    projectionPartId: 91,
    partKey: "frame/a.stl",
    effectiveRole: "accepted-frame",
    quantityInferred: 3,
    effectiveQuantity: 4,
  };

  it("uses accepted revision effective role and quantity fields", () => {
    expect(acceptedRevisionPartRow(acceptedPart)).toMatchObject({
      id: 91,
      match_key: "frame/a.stl",
      role: "accepted-frame",
      quantity_auto: 3,
      quantity_effective: 4,
    });
  });

  it("rejects accepted revision parts without a projection id", () => {
    expect(() => acceptedRevisionPartRow({ ...acceptedPart, projectionPartId: null })).toThrow(
      "Accepted Plan revision Part has no compatibility projection ID",
    );
  });
});
