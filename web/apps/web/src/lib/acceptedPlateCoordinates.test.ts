import { describe, expect, it } from "vitest";
import {
  acceptedPlatePositionInBounds,
  parseMillimetresToMicrometres,
  pointerToAcceptedPlateOrigin,
} from "./acceptedPlateCoordinates";

describe("accepted Plate coordinates", () => {
  it("inverts the SVG screen transform, preserves grab offset, clamps, and rounds", () => {
    expect(pointerToAcceptedPlateOrigin({
      clientX: 104.75,
      clientY: 65.25,
      screenTransform: { a: 0.002, b: 0, c: 0, d: 0.002, e: 50, f: 20 },
      grabOffsetXUm: 1_250,
      grabOffsetYUm: 2_750,
      bedWidthUm: 250_000,
      bedDepthUm: 210_000,
      marginUm: 4_000,
      unitWidthUm: 30_000,
      unitDepthUm: 20_000,
    })).toEqual({ xUm: 26_125, yUm: 19_875 });

    expect(pointerToAcceptedPlateOrigin({
      clientX: 1_000,
      clientY: 1_000,
      screenTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      grabOffsetXUm: 0,
      grabOffsetYUm: 0,
      bedWidthUm: 100,
      bedDepthUm: 80,
      marginUm: 4,
      unitWidthUm: 30,
      unitDepthUm: 20,
    })).toEqual({ xUm: 66, yUm: 56 });
  });

  it("handles a general affine transform instead of a bounding-box ratio", () => {
    expect(pointerToAcceptedPlateOrigin({
      clientX: 3,
      clientY: 7,
      screenTransform: { a: 0, b: 1, c: -1, d: 0, e: 10, f: 0 },
      grabOffsetXUm: 0,
      grabOffsetYUm: 0,
      bedWidthUm: 100,
      bedDepthUm: 100,
      marginUm: 0,
      unitWidthUm: 10,
      unitDepthUm: 10,
    })).toEqual({ xUm: 7, yUm: 7 });
  });

  it("parses millimetres directly to integer micrometres", () => {
    expect(parseMillimetresToMicrometres("12.345")).toBe(12_345);
    expect(parseMillimetresToMicrometres("12.3")).toBe(12_300);
    expect(parseMillimetresToMicrometres("0.001")).toBe(1);
    expect(parseMillimetresToMicrometres("-1.25")).toBe(-1_250);
    expect(parseMillimetresToMicrometres("12.3456")).toBeNull();
    expect(parseMillimetresToMicrometres("1e3")).toBeNull();
    expect(parseMillimetresToMicrometres("NaN")).toBeNull();
  });

  it("checks the captured printable area using integer micrometres", () => {
    const bounds = {
      bedWidthUm: 250_000,
      bedDepthUm: 210_000,
      marginUm: 4_000,
      unitWidthUm: 30_000,
      unitDepthUm: 20_000,
    };
    expect(acceptedPlatePositionInBounds({ ...bounds, xUm: 4_000, yUm: 4_000 })).toBe(true);
    expect(acceptedPlatePositionInBounds({ ...bounds, xUm: 216_000, yUm: 186_000 })).toBe(true);
    expect(acceptedPlatePositionInBounds({ ...bounds, xUm: 216_001, yUm: 186_000 })).toBe(false);
  });
});
