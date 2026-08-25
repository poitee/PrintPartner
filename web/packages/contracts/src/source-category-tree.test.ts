import { describe, expect, it } from "vitest";
import {
  buildSourceCategoryTree,
  categoryAncestorPaths,
  categoryLeafName,
  categoryParentPath,
  flattenSourceCategoryTree,
  isCategoryPathWithin,
  normalizeSourceCategoryPaths,
  rewriteCategoryPath,
} from "./source-category-tree.js";

describe("source category paths", () => {
  it("reads a path as a category and its subcategories", () => {
    expect(categoryLeafName("Voron/Voron 2.4")).toBe("Voron 2.4");
    expect(categoryParentPath("Voron/Voron 2.4")).toBe("Voron");
    expect(categoryParentPath("Voron")).toBe(null);
    expect(categoryAncestorPaths("Voron/Mods/Skirts")).toEqual(["Voron", "Voron/Mods"]);
  });

  it("matches a subtree without matching a same-prefix sibling", () => {
    expect(isCategoryPathWithin("Voron/Trident", "Voron")).toBe(true);
    expect(isCategoryPathWithin("Voron", "Voron")).toBe(true);
    expect(isCategoryPathWithin("voron/trident", "Voron")).toBe(true);
    expect(isCategoryPathWithin("Voron 2/Trident", "Voron")).toBe(false);
    expect(isCategoryPathWithin("Voron", "Voron/Trident")).toBe(false);
  });

  it("normalizes spacing, drops duplicates, and inserts missing parents", () => {
    expect(normalizeSourceCategoryPaths([" Voron / Trident ", "Voron", "voron"])).toEqual([
      "Voron",
      "Voron/Trident",
    ]);
    expect(normalizeSourceCategoryPaths(["Mods", "", "  ", 7, null])).toEqual(["Mods"]);
  });

  it("keeps a legacy flat list unchanged", () => {
    const legacy = ["Printer kits", "Toolheads", "Mods"];
    expect(normalizeSourceCategoryPaths(legacy)).toEqual(legacy);
  });

  it("round-trips between the flat list and the tree", () => {
    const paths = ["Voron", "Voron/Trident", "Voron/Trident/Mods", "Toolheads"];
    const tree = buildSourceCategoryTree(paths);
    expect(tree.map((node) => node.path)).toEqual(["Voron", "Toolheads"]);
    expect(tree[0]!.children[0]!.path).toBe("Voron/Trident");
    expect(tree[0]!.children[0]!.depth).toBe(1);
    expect(flattenSourceCategoryTree(tree).map((node) => node.path)).toEqual(paths);
  });

  it("rewrites paths when an ancestor moves or is deleted", () => {
    expect(rewriteCategoryPath("Voron/Trident", "Voron", "VORON kits")).toBe(
      "VORON kits/Trident",
    );
    expect(rewriteCategoryPath("Voron/Trident", "Voron", null)).toBe(null);
    expect(rewriteCategoryPath("Prusa/Mods", "Voron", "VORON kits")).toBeUndefined();
  });
});
