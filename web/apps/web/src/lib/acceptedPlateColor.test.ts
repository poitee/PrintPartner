import { describe, expect, it } from "vitest";
import { acceptedPlateUnitColor } from "./acceptedPlateColor";

describe("accepted Plate colors", () => {
  it("uses the resolved hex selected for a unit", () => {
    expect(acceptedPlateUnitColor({ filament_hex: "#FF6600" })).toBe("#FF6600");
  });

  it("falls back to a custom hex for older workspace payloads", () => {
    expect(acceptedPlateUnitColor({ filament_hex: null, filament_custom_hex: "#008000" })).toBe("#008000");
  });

  it("ignores invalid values", () => {
    expect(acceptedPlateUnitColor({ filament_hex: "not-a-color", filament_custom_hex: "also-not-a-color" })).toBeUndefined();
  });
});
