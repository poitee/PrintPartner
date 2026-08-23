import { describe, expect, it } from "vitest";
import { rankFilamentMatches } from "./filament-matches.js";

const inventory = [
  { id: "green", display_name: "Forest Green", product_line: "Brand A", hex: "#285238", combo_label: "", swatch_url: "" },
  { id: "orange", display_name: "Bright Orange", product_line: "KB3D", hex: "#ff6500", combo_label: "", swatch_url: "" },
  { id: "red", display_name: "Red", product_line: "Brand B", hex: "#ff0000", combo_label: "", swatch_url: "" },
];

describe("filament matching", () => {
  it("ranks exact brand and name before color distance", () => {
    const matches = rankFilamentMatches(inventory, {
      name: "Bright Orange",
      brand: "KB3D",
      colorHex: "#ff0000",
    });
    expect(matches[0]).toMatchObject({ id: "orange", exact_name: true, brand_match: true });
  });

  it("uses RGB distance when an exact inventory name is unavailable", () => {
    const matches = rankFilamentMatches(inventory, {
      name: "Customer Tangerine",
      colorHex: "#fa6805",
    });
    expect(matches[0]).toMatchObject({ id: "orange" });
    const firstDistance = matches[0]?.color_distance;
    const secondDistance = matches[1]?.color_distance;
    expect(firstDistance).not.toBeNull();
    expect(secondDistance).not.toBeNull();
    if (firstDistance == null || secondDistance == null) throw new Error("Expected color distances");
    expect(firstDistance).toBeLessThan(secondDistance);
  });
});
