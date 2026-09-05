import { describe, expect, it } from "vitest";
import {
  cloneManifestSelections,
  manifestSelectionEqual,
  parseManifestSelections,
} from "./manifest-selections.js";

describe("manifest selections", () => {
  it("parses scalar, multi-select, and explicit-empty values", () => {
    expect(
      parseManifestSelections({
        toolhead: "stealthburner",
        extras: ["skirts", "panels"],
        optional: [],
      }),
    ).toEqual({
      toolhead: "stealthburner",
      extras: ["skirts", "panels"],
      optional: [],
    });
  });

  it("rejects duplicate and non-string values", () => {
    expect(() => parseManifestSelections(null)).toThrow("selections must be an object");
    expect(() => parseManifestSelections({ extras: ["skirts", "skirts"] })).toThrow(
      "duplicate",
    );
    expect(() => parseManifestSelections({ extras: ["skirts", 4] })).toThrow(
      "non-empty string",
    );
  });

  it("clones arrays and compares selection sets without using their order", () => {
    const original = { extras: ["skirts", "panels"] };
    const cloned = cloneManifestSelections(original);

    expect(cloned).toEqual(original);
    expect(cloned.extras).not.toBe(original.extras);
    expect(manifestSelectionEqual(["skirts", "panels"], ["panels", "skirts"])).toBe(
      true,
    );
  });
});
