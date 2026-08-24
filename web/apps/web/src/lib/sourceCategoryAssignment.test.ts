import { describe, expect, it } from "vitest";
import { UNCategorized_FILTER } from "../components/sources/sourceLabels";
import {
  countSourcesByCategory,
  matchesSourceCategoryFilter,
  sourceCategoryBucket,
  sourceCategoryLabel,
  reconcileSourceCategoryFilter,
} from "./sourceCategoryAssignment";

describe("sourceCategoryAssignment", () => {
  it("resets a persisted filter whose category no longer exists", () => {
    expect(reconcileSourceCategoryFilter("Mods", ["Hardware"])).toBe("all");
    expect(reconcileSourceCategoryFilter("Hardware", ["Hardware"])).toBe("Hardware");
    expect(reconcileSourceCategoryFilter(UNCategorized_FILTER, ["Hardware"])).toBe(
      UNCategorized_FILTER,
    );
  });
  it("buckets blank categories as uncategorised", () => {
    expect(sourceCategoryBucket(null)).toBe(null);
    expect(sourceCategoryBucket("")).toBe(null);
    expect(sourceCategoryBucket("  ")).toBe(null);
    expect(sourceCategoryBucket("Mods")).toBe("Mods");
  });

  it("filters by category including Uncategorised", () => {
    expect(matchesSourceCategoryFilter("Mods", "all")).toBe(true);
    expect(matchesSourceCategoryFilter(null, "all")).toBe(true);
    expect(matchesSourceCategoryFilter("Mods", "Mods")).toBe(true);
    expect(matchesSourceCategoryFilter("Mods", "Hardware")).toBe(false);
    expect(matchesSourceCategoryFilter(null, UNCategorized_FILTER)).toBe(true);
    expect(matchesSourceCategoryFilter("", UNCategorized_FILTER)).toBe(true);
    expect(matchesSourceCategoryFilter("Mods", UNCategorized_FILTER)).toBe(false);
  });

  it("counts sources per category", () => {
    const counts = countSourcesByCategory([
      { category: "Mods" },
      { category: "Mods" },
      { category: null },
      { category: "  " },
      { category: "Hardware" },
    ]);
    expect(counts.get("Mods")).toBe(2);
    expect(counts.get("Hardware")).toBe(1);
    expect(counts.get(null)).toBe(2);
  });

  it("labels blank as Uncategorised", () => {
    expect(sourceCategoryLabel(null)).toBe("Uncategorised");
    expect(sourceCategoryLabel("Toolheads")).toBe("Toolheads");
  });
});
