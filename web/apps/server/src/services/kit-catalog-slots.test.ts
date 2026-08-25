import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKitCatalog } from "./kit-catalog.js";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../test-fixtures/kit-workspace",
);

describe("kit catalog functional slots", () => {
  it("ships no bases, addon sources or presets of its own", () => {
    // Print Partner is agnostic about what you build: the shipped catalog
    // carries the slot taxonomy and nothing else.
    const catalog = loadKitCatalog(null);
    expect(catalog.bases).toEqual({});
    expect(catalog.stack_presets).toEqual({});
    const categories = catalog.addon_categories as Record<
      string,
      { sources?: Array<{ name?: string }> }
    >;
    expect(Object.keys(categories).length).toBeGreaterThan(0);
    for (const [id, category] of Object.entries(categories)) {
      expect(category.sources ?? [], `${id} ships sources`).toEqual([]);
    }
  });

  it("keeps the functional slot taxonomy so a supplied catalog can compose", () => {
    const categories = loadKitCatalog(null).addon_categories as Record<
      string,
      { replaces_slot?: string; rule?: string }
    >;
    expect(categories.extruder).toMatchObject({ replaces_slot: "extruder" });
    expect(categories.hotend).toMatchObject({ replaces_slot: "hotend" });
    expect(categories.toolhead).toMatchObject({ replaces_slot: "toolhead" });
    expect(categories.toolhead_electronics).toMatchObject({
      replaces_slot: "toolhead_electronics",
    });
    // Toolhead and extruder are separate slots, so they compose rather than
    // being treated as alternatives to one another.
    expect(categories.toolhead?.replaces_slot).not.toBe(categories.extruder?.replaces_slot);
  });

  it("reads a supplied catalog from the data directory", () => {
    const catalog = loadKitCatalog(FIXTURE);
    const categories = catalog.addon_categories as Record<
      string,
      { sources?: Array<{ name?: string }> }
    >;
    expect(categories.toolhead?.sources?.map((s) => s.name)).toContain("Example-Toolhead");
    expect(categories.toolhead?.sources?.map((s) => s.name)).not.toContain("Example-Extruder");
    expect(categories.extruder?.sources?.map((s) => s.name)).toContain("Example-Extruder");
    expect((catalog.bases as Record<string, unknown>).example_printer).toBeDefined();
  });
});
