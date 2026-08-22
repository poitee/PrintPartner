import { describe, expect, it } from "vitest";
import {
  mergeLayers,
  findActiveSlugConflictKeys,
  mergeConflictIssueMessage,
  type MergePart,
} from "./merge.js";
import type { ScannedPart } from "./scanner.js";

function part(rel: string, slug: string): ScannedPart {
  return {
    relativePath: rel,
    filename: rel.split("/").pop() ?? rel,
    matchKey: rel.toLowerCase(),
    partSlug: slug,
    role: "primary",
    quantity: 1,
    absolutePath: `/tmp/${rel}`,
  };
}

describe("mergeLayers", () => {
  it("addon adds part", () => {
    const result = mergeLayers([
      ["base", [part("base/a.stl", "a")]],
      ["addon", [part("addon/b.stl", "b")]],
    ]);
    const keys = new Set(result.parts.map((p) => p.matchKey));
    expect(keys.has("base/a.stl")).toBe(true);
    expect(keys.has("addon/b.stl")).toBe(true);
    expect(result.parts.find((p) => p.matchKey === "addon/b.stl")?.status).toBe("added");
  });

  it("addon replaces same key", () => {
    const result = mergeLayers([
      ["base", [part("shared/part.stl", "part")]],
      ["addon", [part("shared/part.stl", "part")]],
    ]);
    const p = result.parts.find((x) => x.matchKey === "shared/part.stl");
    expect(p?.status).toBe("replaced");
    expect(p?.sourceLayer).toBe("addon");
  });

  it("flags slug conflict", () => {
    const result = mergeLayers([
      ["base", [part("a/widget.stl", "widget")]],
      ["addon", [part("b/widget_alt.stl", "widget")]],
    ]);
    expect(result.parts.some((p) => p.status === "conflict")).toBe(true);
  });

  it("preserves override", () => {
    const existing: Record<string, MergePart> = {
      "x.stl": {
        matchKey: "x.stl",
        relativePath: "x.stl",
        filename: "x.stl",
        sourceLayer: "base",
        status: "base",
        role: "primary",
        quantityAuto: 1,
        partSlug: "x",
        quantityOverride: 5,
        notes: "keep",
        included: true,
        geometrySame: null,
        absolutePath: null,
      },
    };
    const result = mergeLayers([["base", [part("x.stl", "x")]]], existing);
    expect(result.parts[0].quantityOverride).toBe(5);
    expect(result.parts[0].notes).toBe("keep");
  });

  it("preserves included flag when excluded", () => {
    const existing: Record<string, MergePart> = {
      "x.stl": {
        matchKey: "x.stl",
        relativePath: "x.stl",
        filename: "x.stl",
        sourceLayer: "base",
        status: "excluded",
        role: "primary",
        quantityAuto: 1,
        partSlug: "x",
        quantityOverride: null,
        notes: "",
        included: false,
        geometrySame: null,
        absolutePath: null,
      },
    };
    const result = mergeLayers([["base", [part("x.stl", "x")]]], existing);
    expect(result.parts[0].included).toBe(false);
    expect(result.parts[0].status).toBe("excluded");
  });
});

describe("findActiveSlugConflictKeys", () => {
  it("returns keys only when multiple included parts share a slug", () => {
    const keys = findActiveSlugConflictKeys([
      {
        matchKey: "a/widget.stl",
        relativePath: "a/widget.stl",
        filename: "widget.stl",
        included: true,
        partSlug: "widget",
      },
      {
        matchKey: "b/widget.stl",
        relativePath: "b/widget.stl",
        filename: "widget.stl",
        included: true,
        partSlug: "widget",
      },
    ]);
    expect(keys).toEqual(new Set(["a/widget.stl", "b/widget.stl"]));
  });

  it("clears conflict when all but one duplicate is excluded", () => {
    const keys = findActiveSlugConflictKeys([
      {
        matchKey: "a/widget.stl",
        relativePath: "a/widget.stl",
        filename: "widget.stl",
        included: true,
        partSlug: "widget",
      },
      {
        matchKey: "b/widget.stl",
        relativePath: "b/widget.stl",
        filename: "widget.stl",
        included: false,
        partSlug: "widget",
      },
    ]);
    expect(keys.size).toBe(0);
  });
});

describe("mergeConflictIssueMessage", () => {
  it("points operators to Plan source cards without Review/Build", () => {
    const msg = mergeConflictIssueMessage("widget.stl");
    expect(msg).toBe(
      "Merge conflict for widget.stl — exclude duplicates on the Plan source cards.",
    );
    expect(msg.toLowerCase()).not.toContain("review");
    expect(msg).not.toMatch(/\bBuild\b/);
  });
});
