import { describe, expect, it } from "vitest";
import {
  defaultSlicerDialect,
  isSafeSlicerGuiUrl,
  slicerCreatePayloadFromDraft,
} from "./slicerSettingsModel";

describe("slicer settings model", () => {
  it("picks default dialects by slicer kind", () => {
    expect(defaultSlicerDialect("orca")).toBe("orca_json");
    expect(defaultSlicerDialect("prusa")).toBe("prusa_ini");
    expect(defaultSlicerDialect("bambu")).toBe("bambu_json");
    expect(defaultSlicerDialect("custom")).toBe("orca_json");
  });

  it("accepts only HTTP GUI URLs", () => {
    expect(isSafeSlicerGuiUrl("https://slicer.example.test")).toBe(true);
    expect(isSafeSlicerGuiUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isSafeSlicerGuiUrl("file:///tmp/slicer")).toBe(false);
    expect(isSafeSlicerGuiUrl("not a url")).toBe(false);
  });

  it("normalizes create payloads", () => {
    expect(
      slicerCreatePayloadFromDraft({
        name: "",
        kind: "prusa",
        dialect: "orca_json",
        guiUrl: " https://slicer.example.test ",
        watchPath: " /profiles ",
      }),
    ).toEqual({
      name: "PrusaSlicer",
      kind: "prusa",
      dialect: "prusa_ini",
      gui_url: "https://slicer.example.test",
      watch_path: "/profiles",
      enabled: true,
    });
  });
});
