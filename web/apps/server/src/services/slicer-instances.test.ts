import { describe, expect, it } from "vitest";
import {
  defaultWatchDirs,
  dialectToSyncKind,
  stockPresets,
  validateSlicerGuiUrl,
} from "./slicer-instances.js";

describe("dialectToSyncKind", () => {
  it("maps dialects to profile-sync kinds", () => {
    expect(dialectToSyncKind("orca_json")).toBe("orca");
    expect(dialectToSyncKind("bambu_json")).toBe("bambu");
    expect(dialectToSyncKind("prusa_ini")).toBe("prusa");
  });
});

describe("defaultWatchDirs", () => {
  it("returns Orca relative dirs", () => {
    expect(defaultWatchDirs("orca_json").printer).toContain("OrcaSlicer");
  });
  it("returns Prusa relative dirs", () => {
    expect(defaultWatchDirs("prusa_ini").process).toBe(".config/PrusaSlicer/print");
  });
  it("returns Bambu relative dirs", () => {
    expect(defaultWatchDirs("bambu_json").filament).toContain("BambuStudio");
  });
});

describe("stockPresets", () => {
  it("returns three stock slicers with default paths", () => {
    const presets = stockPresets({});
    expect(presets).toHaveLength(3);
    expect(presets.map((p) => p.kind)).toEqual(["orca", "prusa", "bambu"]);
    expect(presets[0]!.watch_path).toBe("/slicer-profiles/orca");
  });

  it("honors SLICER_*_DIR env overrides", () => {
    const presets = stockPresets({
      SLICER_ORCA_DIR: "/custom/orca",
      SLICER_PRUSA_DIR: "/custom/prusa",
      SLICER_BAMBU_DIR: "/custom/bambu",
    });
    expect(presets[0]!.watch_path).toBe("/custom/orca");
    expect(presets[1]!.watch_path).toBe("/custom/prusa");
    expect(presets[2]!.watch_path).toBe("/custom/bambu");
  });
});

describe("validateSlicerGuiUrl", () => {
  it("allows empty and http(s) URLs", () => {
    expect(validateSlicerGuiUrl("")).toBeNull();
    expect(validateSlicerGuiUrl("http://orca.home")).toBeNull();
    expect(validateSlicerGuiUrl("https://slicer.example")).toBeNull();
  });

  it("rejects unsafe schemes", () => {
    expect(validateSlicerGuiUrl("javascript:alert(1)")).toMatch(/http/);
    expect(validateSlicerGuiUrl("not a url")).toMatch(/valid/);
  });
});
