import { describe, expect, it } from "vitest";
import {
  STL_NAMING_ROLE_LABELS,
  isEngineNotFoundError,
  markersToInput,
  parseMarkersInput,
} from "./stlNamingSettingsModel";

describe("stlNamingSettingsModel", () => {
  it("formats and parses marker input", () => {
    expect(markersToInput(["[a]", "accent"])).toBe("[a], accent");
    expect(parseMarkersInput(" [a], , accent ")).toEqual(["[a]", "accent"]);
  });

  it("exposes role labels", () => {
    expect(STL_NAMING_ROLE_LABELS).toMatchObject({
      primary: "Primary",
      accent: "Accent",
      clear: "Clear",
      opaque: "Opaque",
    });
  });

  it("detects engine not-found errors", () => {
    expect(isEngineNotFoundError(new Error("HTTP 404"))).toBe(true);
    expect(isEngineNotFoundError("404 missing")).toBe(true);
    expect(isEngineNotFoundError(new Error("HTTP 500"))).toBe(false);
  });
});
