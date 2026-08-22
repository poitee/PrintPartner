import { describe, expect, it } from "vitest";
import { catalogColorGroups } from "./FilamentSwatch";
import type { FilamentCatalog } from "../api/engine";

describe("catalogColorGroups", () => {
  it("includes Spoolman optgroup when spoolman_colors present", () => {
    const catalog: FilamentCatalog = {
      synced_at: "2026-01-01",
      source: "test",
      status: "ok",
      colors: [{ id: "a", display_name: "A", product_line: "L", hex: "#111", combo_label: "L · A", swatch_url: "" }],
      custom_colors: [],
      spoolman_colors: [
        {
          id: "spoolman:x:filament:1",
          display_name: "Red",
          product_line: "Vendor PLA",
          hex: "#f00",
          combo_label: "Vendor PLA · Red",
          swatch_url: "",
        },
      ],
    };
    const groups = catalogColorGroups(catalog);
    expect(groups.map((g) => g.label)).toEqual(["Catalog", "Spoolman"]);
    expect(groups[1]?.colors[0]?.id).toBe("spoolman:x:filament:1");
  });
});
