import { describe, expect, it } from "vitest";
import {
  acceptedPlateUnitsViolateClearance,
  arrangeAcceptedUnits,
  packAcceptedUnits,
} from "./accepted-plate-packer.js";

describe("acceptedPlateUnitsViolateClearance", () => {
  const left = { xUm: 10, yUm: 10, widthUm: 30, depthUm: 20 };

  it("accepts exact clearance and rejects one micrometre less", () => {
    expect(acceptedPlateUnitsViolateClearance(
      left,
      { xUm: 50, yUm: 10, widthUm: 20, depthUm: 20 },
      10,
    )).toBe(false);
    expect(acceptedPlateUnitsViolateClearance(
      left,
      { xUm: 49, yUm: 10, widthUm: 20, depthUm: 20 },
      10,
    )).toBe(true);
  });
});

describe("packAcceptedUnits", () => {
  it("uses integer rows with a fixed gap and deterministic unit order", () => {
    const result = packAcceptedUnits({
      printer: {
        bedWidthUm: 120,
        bedDepthUm: 100,
        bedHeightUm: 80,
        marginUm: 10,
      },
      units: [
        { token: "c", widthUm: 30, depthUm: 20, heightUm: 10 },
        { token: "a", widthUm: 50, depthUm: 30, heightUm: 10 },
        { token: "b", widthUm: 40, depthUm: 40, heightUm: 10 },
      ],
    });

    expect(result).toEqual({
      kind: "packed",
      plates: [
        {
          units: [
            { token: "a", widthUm: 50, depthUm: 30, heightUm: 10, xUm: 10, yUm: 10 },
            { token: "b", widthUm: 40, depthUm: 40, heightUm: 10, xUm: 70, yUm: 10 },
            { token: "c", widthUm: 30, depthUm: 20, heightUm: 10, xUm: 10, yUm: 60 },
          ],
        },
      ],
    });
  });

  it("does not rotate a unit to make it fit", () => {
    expect(packAcceptedUnits({
      printer: {
        bedWidthUm: 100,
        bedDepthUm: 140,
        bedHeightUm: 80,
        marginUm: 10,
      },
      units: [{ token: "wide", widthUm: 100, depthUm: 70, heightUm: 10 }],
    })).toEqual({ kind: "unit_too_large", token: "wide" });
  });

  it("splits rows across stable local Plate order", () => {
    const result = packAcceptedUnits({
      printer: {
        bedWidthUm: 100,
        bedDepthUm: 100,
        bedHeightUm: 80,
        marginUm: 10,
      },
      units: [
        { token: "a", widthUm: 70, depthUm: 70, heightUm: 10 },
        { token: "b", widthUm: 70, depthUm: 70, heightUm: 10 },
      ],
    });

    expect(result).toMatchObject({
      kind: "packed",
      plates: [
        { units: [{ token: "a", xUm: 10, yUm: 10 }] },
        { units: [{ token: "b", xUm: 10, yUm: 10 }] },
      ],
    });
  });
});

describe("arrangeAcceptedUnits", () => {
  const printer = {
    bedWidthUm: 120,
    bedDepthUm: 100,
    bedHeightUm: 80,
    marginUm: 10,
  };
  const automatic = {
    token: "automatic",
    widthUm: 30,
    depthUm: 20,
    heightUm: 10,
    xUm: 70,
    yUm: 50,
    placement: "auto" as const,
  };
  const manual = {
    token: "manual",
    widthUm: 30,
    depthUm: 20,
    heightUm: 10,
    xUm: 40,
    yUm: 40,
    placement: "manual" as const,
  };

  it("preserves an automatically placed unit only while it is pinned", () => {
    const pinned = arrangeAcceptedUnits({
      mode: "unplaced",
      printer,
      units: [{ ...automatic, pinned: true }],
    });
    const unpinned = arrangeAcceptedUnits({
      mode: "unplaced",
      printer,
      units: [{ ...automatic, pinned: false }],
    });
    expect(pinned).toMatchObject({ plates: [{ units: [{ xUm: 70, yUm: 50 }] }] });
    expect(unpinned).toMatchObject({ plates: [{ units: [{ xUm: 10, yUm: 10 }] }] });
  });

  it("preserves a manual placement whether pinned or unpinned", () => {
    for (const pinned of [true, false]) {
      expect(arrangeAcceptedUnits({
        mode: "unplaced",
        printer,
        units: [{ ...manual, pinned }],
      })).toMatchObject({ plates: [{ units: [{ xUm: 40, yUm: 40 }] }] });
    }
  });

  it("packs movable units around fixed manual and pinned units", () => {
    const result = arrangeAcceptedUnits({
      mode: "unplaced",
      printer,
      units: [
        { ...manual, pinned: false },
        { ...automatic, token: "pinned-auto", pinned: true, xUm: 80, yUm: 10 },
        { ...automatic, token: "moving-auto", pinned: false },
        { ...automatic, token: "unplaced", placement: "unplaced", pinned: false, xUm: 0, yUm: 0 },
      ],
    });
    expect(result.kind).toBe("packed");
    if (result.kind !== "packed") return;
    const byToken = new Map(result.plates.flatMap((plate) => plate.units).map((unit) => [unit.token, unit]));
    expect(byToken.get("manual")).toMatchObject({ xUm: 40, yUm: 40 });
    expect(byToken.get("pinned-auto")).toMatchObject({ xUm: 80, yUm: 10 });
    expect(byToken.get("moving-auto")).not.toMatchObject({ xUm: 70, yUm: 50 });
    expect(byToken.get("unplaced")).toBeDefined();
  });

  it("arrange all replaces every coordinate", () => {
    expect(arrangeAcceptedUnits({
      mode: "all",
      printer,
      units: [{ ...manual, pinned: true }, { ...automatic, pinned: false }],
    })).toEqual({
      kind: "packed",
      plates: [{
        units: [
          { token: "automatic", widthUm: 30, depthUm: 20, heightUm: 10, xUm: 10, yUm: 10 },
          { token: "manual", widthUm: 30, depthUm: 20, heightUm: 10, xUm: 50, yUm: 10 },
        ],
      }],
    });
  });
});
