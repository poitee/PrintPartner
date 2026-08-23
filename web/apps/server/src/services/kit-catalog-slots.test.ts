import { describe, expect, it } from "vitest";
import { loadKitCatalog } from "./kit-catalog.js";

describe("kit catalog functional slots", () => {
  it("composes Stealthburner with G2E instead of treating them as alternatives", () => {
    const catalog = loadKitCatalog();
    const categories = catalog.addon_categories as Record<
      string,
      { replaces_slot?: string; sources?: Array<{ name?: string }> }
    >;

    expect(categories.toolhead?.sources?.map((source) => source.name)).toContain(
      "Voron-Stealthburner",
    );
    expect(categories.toolhead?.sources?.map((source) => source.name)).not.toContain(
      "Galileo2",
    );
    expect(categories.extruder).toMatchObject({ replaces_slot: "extruder" });
    expect(categories.extruder?.sources?.map((source) => source.name)).toContain(
      "Galileo2",
    );
    expect(categories.hotend).toMatchObject({ replaces_slot: "hotend" });
    expect(categories.toolhead_electronics).toMatchObject({
      replaces_slot: "toolhead_electronics",
    });
  });
});
