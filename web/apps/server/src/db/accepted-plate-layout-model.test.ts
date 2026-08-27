import { describe, expect, it } from "vitest";
import {
  layoutDigest,
  LEGACY_ACCEPTED_PLATE_LAYOUT_FORMAT,
  normalizedText,
  unitDimensionsFitPrintableArea,
  unitPinned,
  unitPlacement,
  validatePlates,
} from "./accepted-plate-layout-model.js";
import type { AcceptedPlateInput } from "./accepted-plates.js";

const tokenA = "ppu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const tokenB = "ppu_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function plate(units: AcceptedPlateInput["units"]): AcceptedPlateInput {
  return {
    plateId: " plate-1 ",
    printerId: " printer-1 ",
    printerName: " Printer One ",
    printerModel: " Model One ",
    bedWidthUm: 200_000,
    bedDepthUm: 200_000,
    bedHeightUm: 200_000,
    marginUm: 5_000,
    units,
  };
}

describe("accepted plate layout model", () => {
  it("normalizes plate text and unit placement", () => {
    const result = validatePlates(
      [
        plate([
          {
            token: tokenA,
            xUm: 5_000,
            yUm: 5_000,
            widthUm: 10_000,
            depthUm: 10_000,
            heightUm: 10_000,
          },
        ]),
      ],
      new Set([tokenA]),
    );

    expect(result).toMatchObject({
      kind: "ready",
      plates: [
        {
          ordinal: 1,
          plateId: "plate-1",
          printerId: "printer-1",
          printerName: "Printer One",
          printerModel: "Model One",
          units: [{ placement: "auto", pinned: false }],
        },
      ],
    });
    expect(unitPlacement({ token: tokenA, xUm: 0, yUm: 0, widthUm: 1, depthUm: 1, heightUm: 1 })).toBe(
      "auto",
    );
    expect(unitPinned({ token: tokenA, xUm: 0, yUm: 0, widthUm: 1, depthUm: 1, heightUm: 1, pinned: true })).toBe(
      true,
    );
    expect(normalizedText(" value ")).toBe("value");
    expect(normalizedText(" ")).toBeNull();
  });

  it("requires every expected token by default", () => {
    expect(validatePlates([plate([])], new Set([tokenA]))).toEqual({ kind: "invalid_units" });
    expect(validatePlates([plate([])], new Set([tokenA]), false)).toEqual({ kind: "invalid_units" });
  });

  it("rejects unknown, duplicate, and malformed tokens", () => {
    expect(validatePlates([plate([{ token: tokenB, xUm: 5_000, yUm: 5_000, widthUm: 1, depthUm: 1, heightUm: 1 }])], new Set([tokenA]))).toEqual({ kind: "invalid_units" });
    expect(
      validatePlates(
        [
          plate([
            { token: tokenA, xUm: 5_000, yUm: 5_000, widthUm: 1, depthUm: 1, heightUm: 1 },
            { token: tokenA, xUm: 6_000, yUm: 6_000, widthUm: 1, depthUm: 1, heightUm: 1 },
          ]),
        ],
        new Set([tokenA]),
      ),
    ).toEqual({ kind: "invalid_units" });
    expect(validatePlates([plate([{ token: "bad", xUm: 5_000, yUm: 5_000, widthUm: 1, depthUm: 1, heightUm: 1 }])], new Set(["bad"]))).toEqual({ kind: "invalid_units" });
  });

  it("rejects units outside the printable area and units that violate clearance", () => {
    expect(
      validatePlates(
        [plate([{ token: tokenA, xUm: 0, yUm: 5_000, widthUm: 10_000, depthUm: 10_000, heightUm: 10_000 }])],
        new Set([tokenA]),
      ),
    ).toEqual({ kind: "invalid_geometry", reason: "outside_build_area" });

    expect(
      validatePlates(
        [
          plate([
            { token: tokenA, xUm: 5_000, yUm: 5_000, widthUm: 10_000, depthUm: 10_000, heightUm: 10_000 },
            { token: tokenB, xUm: 16_000, yUm: 5_000, widthUm: 10_000, depthUm: 10_000, heightUm: 10_000 },
          ]),
        ],
        new Set([tokenA, tokenB]),
      ),
    ).toEqual({ kind: "invalid_geometry", reason: "overlapping_units" });
  });

  it("allows unplaced units and clears their pinned flag", () => {
    const result = validatePlates(
      [
        plate([
          {
            token: tokenA,
            xUm: 0,
            yUm: 0,
            widthUm: 10_000,
            depthUm: 10_000,
            heightUm: 10_000,
            placement: "unplaced",
            pinned: true,
          },
        ]),
      ],
      new Set([tokenA]),
    );

    expect(result).toMatchObject({ kind: "ready", plates: [{ units: [{ placement: "unplaced", pinned: false }] }] });
  });

  it("checks dimensions against printable area", () => {
    const base = plate([]);
    expect(
      unitDimensionsFitPrintableArea(base, {
        token: tokenA,
        xUm: 0,
        yUm: 0,
        widthUm: 190_000,
        depthUm: 190_000,
        heightUm: 200_000,
      }),
    ).toBe(true);
    expect(
      unitDimensionsFitPrintableArea(base, {
        token: tokenA,
        xUm: 0,
        yUm: 0,
        widthUm: 190_001,
        depthUm: 190_000,
        heightUm: 200_000,
      }),
    ).toBe(false);
  });

  it("computes stable current and legacy digests", () => {
    const result = validatePlates(
      [plate([{ token: tokenA, xUm: 5_000, yUm: 5_000, widthUm: 10_000, depthUm: 10_000, heightUm: 10_000 }])],
      new Set([tokenA]),
    );
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;

    expect(layoutDigest(result.plates)).toMatch(/^[a-f0-9]{64}$/);
    expect(layoutDigest(result.plates, LEGACY_ACCEPTED_PLATE_LAYOUT_FORMAT)).toMatch(/^[a-f0-9]{64}$/);
    expect(layoutDigest(result.plates)).not.toBe(layoutDigest(result.plates, LEGACY_ACCEPTED_PLATE_LAYOUT_FORMAT));
  });
});
