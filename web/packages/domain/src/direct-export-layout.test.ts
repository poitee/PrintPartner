import { describe, expect, it } from "vitest";
import {
  DIRECT_EXPORT_GAP_UM,
  layOutDirectExportUnits,
  type DirectExportLayoutUnit,
  type DirectExportPlacement,
} from "./direct-export-layout.js";

const plates = [
  { ordinal: 1, bedWidthUm: 256_000, bedDepthUm: 256_000 },
  { ordinal: 2, bedWidthUm: 256_000, bedDepthUm: 256_000 },
];

const unit = (token: string, widthUm = 20_000, depthUm = 20_000): DirectExportLayoutUnit =>
  ({ token, widthUm, depthUm });

const placement = (plateOrdinal: number, xUm: number, yUm: number): DirectExportPlacement =>
  ({ plateOrdinal, xUm, yUm });

describe("layOutDirectExportUnits", () => {
  it("keeps each Plate's layout and sets later Plates beside earlier ones", () => {
    const positions = layOutDirectExportUnits({
      units: [unit("a"), unit("b"), unit("c")],
      placements: new Map([
        ["a", placement(1, 5_000, 7_000)],
        ["b", placement(1, 90_000, 7_000)],
        ["c", placement(2, 5_000, 7_000)],
      ]),
      plates,
    });
    expect(positions.get("a")).toEqual({ xUm: 5_000, yUm: 7_000 });
    expect(positions.get("b")).toEqual({ xUm: 90_000, yUm: 7_000 });
    expect(positions.get("c")).toEqual({ xUm: 256_000 + DIRECT_EXPORT_GAP_UM + 5_000, yUm: 7_000 });
  });

  it("shelf-packs never-placed units into a strip past the last Plate", () => {
    const positions = layOutDirectExportUnits({
      units: [unit("a"), unit("x", 200_000, 30_000), unit("y", 200_000, 40_000)],
      placements: new Map([["a", placement(1, 0, 0)]]),
      plates: [plates[0]!],
      gapUm: 10_000,
    });
    const stripStartUm = 256_000 + 10_000;
    expect(positions.get("x")).toEqual({ xUm: stripStartUm, yUm: 0 });
    // 200mm + 200mm exceeds the 256mm strip, so "y" wraps onto the next row.
    expect(positions.get("y")).toEqual({ xUm: stripStartUm, yUm: 30_000 + 10_000 });
  });

  it("spaces every unit out when no Plates were published", () => {
    const positions = layOutDirectExportUnits({
      units: [unit("a", 30_000, 30_000), unit("b", 40_000, 20_000)],
      placements: new Map(),
      plates: [],
      gapUm: 10_000,
    });
    expect(positions.get("a")).toEqual({ xUm: 0, yUm: 0 });
    expect(positions.get("b")).toEqual({ xUm: 40_000, yUm: 0 });
  });

  it("treats a placement on an unknown Plate as never placed", () => {
    const positions = layOutDirectExportUnits({
      units: [unit("a")],
      placements: new Map([["a", placement(9, 5_000, 5_000)]]),
      plates,
      gapUm: 10_000,
    });
    expect(positions.get("a")).toEqual({ xUm: 256_000 * 2 + 10_000 * 2, yUm: 0 });
  });
});
