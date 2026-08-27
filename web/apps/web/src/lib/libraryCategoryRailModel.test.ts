import { buildSourceCategoryTree } from "@print-partner/contracts";
import { describe, expect, it } from "vitest";
import {
  LIBRARY_ADD_ACTIONS,
  buildLibraryCategoryRows,
  categoryRailIndentStyle,
  reorderCategoriesWithinSiblings,
} from "./libraryCategoryRailModel";

describe("libraryCategoryRailModel", () => {
  it("builds fixed and category rows with rollup counts", () => {
    const rows = buildLibraryCategoryRows(
      buildSourceCategoryTree(["Printers", "Printers/Voron", "Mods"]),
      new Map<string | null, number>([
        ["Printers", 1],
        ["Printers/Voron", 2],
        [null, 3],
      ]),
      6,
      new Set(),
    );

    expect(rows.map((row) => row.id)).toEqual([
      "all",
      "Printers",
      "Printers/Voron",
      "Mods",
      "__uncategorized__",
    ]);
    expect(rows.find((row) => row.id === "Printers")?.count).toBe(3);
    expect(rows[0]?.count).toBe(6);
    expect(rows.at(-1)?.count).toBe(3);
  });

  it("hides descendants of collapsed categories", () => {
    const rows = buildLibraryCategoryRows(
      buildSourceCategoryTree(["Printers", "Printers/Voron"]),
      new Map(),
      0,
      new Set(["Printers"]),
    );

    expect(rows.map((row) => row.id)).toEqual(["all", "Printers", "__uncategorized__"]);
    expect(rows.find((row) => row.id === "Printers")?.collapsed).toBe(true);
  });

  it("reorders only within sibling groups", () => {
    expect(
      reorderCategoriesWithinSiblings(["A", "A/One", "A/Two", "B"], "A/Two", "A/One"),
    ).toEqual(["A", "A/Two", "A/One", "B"]);
    expect(reorderCategoriesWithinSiblings(["A", "A/One", "B"], "A/One", "B")).toBeNull();
  });

  it("exports add actions and indent style", () => {
    expect(LIBRARY_ADD_ACTIONS.map((action) => action.id)).toContain("plan-bundle");
    expect(categoryRailIndentStyle(0)).toBeUndefined();
    expect(categoryRailIndentStyle(2)).toEqual({ paddingLeft: "1.5rem" });
  });
});
