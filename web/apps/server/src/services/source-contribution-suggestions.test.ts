import { describe, expect, it } from "vitest";
import { suggestSourceContributions } from "./source-contribution-suggestions.js";

describe("Source contribution suggestions", () => {
  it("discovers Build-scoped slots without domain aliases", () => {
    const suggestions = suggestSourceContributions({
      evidenceId: "nerf-mod",
      sourceName: "Caliburn mods",
      printablePaths: [
        "models/flywheel_cage/cage_left.stl",
        "models/flywheel_cage/cage_right.stl",
        "models/magazine_system/magwell.stl",
      ],
      knownSlots: ["toolhead", "extruder", "probe"],
    });

    expect(suggestions).toEqual([
      expect.objectContaining({
        slot: "flywheel_cage",
        path_scopes: ["models/flywheel_cage/**"],
        confidence: "medium",
      }),
      expect.objectContaining({
        slot: "magazine_system",
        path_scopes: ["models/magazine_system/**"],
        confidence: "medium",
      }),
    ]);
  });

  it("reuses known slots when path vocabulary identifies the responsibility", () => {
    const suggestions = suggestSourceContributions({
      evidenceId: "printer-mod",
      sourceName: "Toolhead mods",
      printablePaths: [
        "STLs/Stealthburner/Printheads/Rapido_UHF/front.stl",
        "STLs/Stealthburner/Printheads/Rapido_UHF/rear.stl",
      ],
      knownSlots: ["toolhead", "hotend", "extruder"],
    });

    expect(suggestions).toEqual([
      expect.objectContaining({
        slot: "hotend",
        confidence: "high",
        path_scopes: ["STLs/Stealthburner/Printheads/Rapido_UHF/**"],
      }),
    ]);
  });
});
