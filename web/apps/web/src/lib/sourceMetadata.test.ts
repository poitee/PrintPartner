import { describe, expect, it } from "vitest";
import { mergeSourceMetadataCategory } from "./sourceMetadata";

describe("mergeSourceMetadataCategory", () => {
  it("leaves metadata untouched when category is undefined", () => {
    const metadata = { source_role: "base" };
    expect(mergeSourceMetadataCategory(metadata, undefined)).toBe(metadata);
  });

  it("sets a concrete category", () => {
    expect(mergeSourceMetadataCategory({ source_role: "base" }, "Terrain/Hills")).toEqual({
      source_role: "base",
      category: "Terrain/Hills",
    });
  });

  it("stores uncategorised as an explicit empty category", () => {
    expect(mergeSourceMetadataCategory({ category: "Old" }, null)).toEqual({ category: "" });
    expect(mergeSourceMetadataCategory(undefined, "")).toEqual({ category: "" });
  });
});
