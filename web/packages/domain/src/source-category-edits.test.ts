import { describe, expect, it } from "vitest";
import {
  addSourceCategoryPath,
  deleteSourceCategoryPath,
  findSourceCategoryPath,
  moveSourceCategoryPath,
} from "./source-category-edits.js";
import { loadSourceCategories, normalizeSourceCategories } from "./source-categories.js";

const CATEGORIES = ["Voron", "Voron/Trident", "Voron/Stealthburner", "Toolheads"];

describe("loadSourceCategories", () => {
  it("loads a saved subcategory list", () => {
    expect(loadSourceCategories(JSON.stringify(CATEGORIES))).toEqual(CATEGORIES);
  });

  it("fills in a parent that was saved without one", () => {
    expect(loadSourceCategories(JSON.stringify(["Voron/Trident"]))).toEqual([
      "Voron",
      "Voron/Trident",
    ]);
  });
});

describe("normalizeSourceCategories", () => {
  it("rejects blank names and over-deep paths", () => {
    expect(() => normalizeSourceCategories([])).toThrow("At least one category is required");
    expect(() => normalizeSourceCategories(["  "])).toThrow("Category names cannot be empty");
    expect(() => normalizeSourceCategories([Array(12).fill("x").join("/")])).toThrow(
      /nest deeper/,
    );
  });
});

describe("addSourceCategoryPath", () => {
  it("inserts a subcategory after its parent's existing subtree", () => {
    const { categories } = addSourceCategoryPath(CATEGORIES, "Voron/Tap");
    expect(categories).toEqual([
      "Voron",
      "Voron/Trident",
      "Voron/Stealthburner",
      "Voron/Tap",
      "Toolheads",
    ]);
  });

  it("creates missing parents", () => {
    const { categories } = addSourceCategoryPath(["Toolheads"], "Prusa/MK4/Mods");
    expect(categories).toEqual(["Toolheads", "Prusa", "Prusa/MK4", "Prusa/MK4/Mods"]);
  });

  it("refuses a duplicate", () => {
    expect(() => addSourceCategoryPath(CATEGORIES, "voron/trident")).toThrow(
      /already exists/,
    );
  });
});

describe("moveSourceCategoryPath", () => {
  it("renames a category and carries its subcategories", () => {
    const { categories, replacements } = moveSourceCategoryPath(CATEGORIES, "Voron", {
      newName: "Voron kits",
    });
    expect(categories).toEqual([
      "Voron kits",
      "Voron kits/Trident",
      "Voron kits/Stealthburner",
      "Toolheads",
    ]);
    expect(replacements).toEqual({
      Voron: "Voron kits",
      "Voron/Trident": "Voron kits/Trident",
      "Voron/Stealthburner": "Voron kits/Stealthburner",
    });
  });

  it("re-parents a category, including to the top level", () => {
    const nested = moveSourceCategoryPath(CATEGORIES, "Toolheads", { newParent: "Voron" });
    expect(nested.categories).toContain("Voron/Toolheads");
    const promoted = moveSourceCategoryPath(nested.categories, "Voron/Toolheads", {
      newParent: "",
    });
    expect(promoted.categories).toContain("Toolheads");
    expect(promoted.replacements).toEqual({ "Voron/Toolheads": "Toolheads" });
  });

  it("refuses a move into its own subtree, an unknown parent, or a collision", () => {
    expect(() => moveSourceCategoryPath(CATEGORIES, "Voron", { newParent: "Voron/Trident" })).toThrow(
      /inside itself/,
    );
    expect(() => moveSourceCategoryPath(CATEGORIES, "Voron", { newParent: "Nope" })).toThrow(
      /Unknown parent/,
    );
    expect(() =>
      moveSourceCategoryPath(CATEGORIES, "Toolheads", { newName: "Voron" }),
    ).toThrow(/already exists/);
  });
});

describe("deleteSourceCategoryPath", () => {
  it("removes the category and its subcategories", () => {
    const { categories, replacements } = deleteSourceCategoryPath(CATEGORIES, "Voron");
    expect(categories).toEqual(["Toolheads"]);
    expect(replacements).toEqual({});
  });

  it("records an explicit reassignment target", () => {
    const { replacements } = deleteSourceCategoryPath(CATEGORIES, "Voron/Trident", "Toolheads");
    expect(replacements).toEqual({ "Voron/Trident": "Toolheads" });
  });

  it("refuses to empty the list or to reassign into the deleted subtree", () => {
    expect(() => deleteSourceCategoryPath(["Only"], "Only")).toThrow("Keep at least one category");
    expect(() => deleteSourceCategoryPath(CATEGORIES, "Voron", "Voron/Trident")).toThrow(
      /being deleted or does not exist/,
    );
  });
});

describe("findSourceCategoryPath", () => {
  it("matches case-insensitively and returns the saved spelling", () => {
    expect(findSourceCategoryPath(CATEGORIES, " voron / trident ")).toBe("Voron/Trident");
    expect(findSourceCategoryPath(CATEGORIES, "missing")).toBe(null);
  });
});
