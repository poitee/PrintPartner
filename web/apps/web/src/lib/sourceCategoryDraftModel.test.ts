import { describe, expect, it } from "vitest";
import {
  categoryRows,
  descendantIds,
  draftPaths,
  orderedRows,
  rowDepth,
  rowPath,
  sameCategories,
  type DraftCategory,
} from "./sourceCategoryDraftModel";

describe("sourceCategoryDraftModel", () => {
  it("compares category lists by ordered value", () => {
    expect(sameCategories(["A", "B"], ["A", "B"])).toBe(true);
    expect(sameCategories(["A", "B"], ["B", "A"])).toBe(false);
  });

  it("splits saved paths into parent-linked rows", () => {
    const rows = categoryRows(["Voron", "Voron/Trident"]);

    expect(rows).toEqual([
      { id: "saved-0", parentId: null, originalPath: "Voron", name: "Voron" },
      {
        id: "saved-1",
        parentId: "saved-0",
        originalPath: "Voron/Trident",
        name: "Trident",
      },
    ]);
  });

  it("orders rows depth-first and builds current paths from renamed parents", () => {
    const draft: DraftCategory[] = [
      { id: "child", parentId: "parent", originalPath: "Voron/Trident", name: "Trident" },
      { id: "sibling", parentId: null, originalPath: "Mods", name: "Mods" },
      { id: "parent", parentId: null, originalPath: "Voron", name: "Voron kits" },
    ];

    expect(orderedRows(draft).map((row) => row.id)).toEqual(["sibling", "parent", "child"]);
    expect(rowDepth(draft, draft[0]!)).toBe(1);
    expect(rowPath(draft, draft[0]!)).toBe("Voron kits/Trident");
    expect(draftPaths(draft)).toEqual(["Mods", "Voron kits", "Voron kits/Trident"]);
  });

  it("collects descendant ids recursively", () => {
    const draft: DraftCategory[] = [
      { id: "parent", parentId: null, originalPath: null, name: "Parent" },
      { id: "child", parentId: "parent", originalPath: null, name: "Child" },
      { id: "grandchild", parentId: "child", originalPath: null, name: "Grandchild" },
      { id: "sibling", parentId: null, originalPath: null, name: "Sibling" },
    ];

    expect(descendantIds(draft, "parent")).toEqual(["child", "grandchild"]);
  });
});
