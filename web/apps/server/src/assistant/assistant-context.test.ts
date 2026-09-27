import { describe, expect, it } from "vitest";
import {
  summarizeKitCatalog,
} from "./assistant-context.js";

const sampleCatalog = {
  version: 1,
  bases: {
    voron_2_4: {
      label: "Voron 2.4",
      source_name: "Voron-2",
      compatible_addons: ["toolhead", "probe"],
    },
  },
  addon_categories: {
    toolhead: {
      rule: "pick_one",
      sources: [{ name: "Voron-Stealthburner" }],
    },
  },
  stack_presets: {
    v24_sb_tap: {
      label: "2.4 + SB + Tap",
      base: "voron_2_4",
      addon_sources: ["Voron-Stealthburner", "Voron-Tap"],
      default_selections: {
        probe: "tap",
        extras: ["skirts", "panels"],
      },
    },
  },
};

describe("summarizeKitCatalog", () => {
  it("includes bases, categories, and stack presets", () => {
    const text = summarizeKitCatalog(sampleCatalog);
    expect(text).toContain("voron_2_4");
    expect(text).toContain("Voron-2");
    expect(text).toContain("toolhead");
    expect(text).toContain("v24_sb_tap");
    expect(text).toContain("probe=tap");
    expect(text).toContain("extras=skirts, panels");
  });
});
