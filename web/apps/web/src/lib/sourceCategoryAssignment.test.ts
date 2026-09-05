import { describe, expect, it } from "vitest";
import { UNCATEGORISED_FILTER } from "../components/sources/sourceLabels";
import {
  countSourcesByCategory,
  matchesSourceCategoryFilter,
  rollupCategoryCount,
  sourceCategoryBucket,
  sourceCategoryLabel,
  reconcileSourceCategoryFilter,
} from "./sourceCategoryAssignment";

describe("sourceCategoryAssignment", () => {
  it("resets a persisted filter whose category no longer exists", () => {
    expect(reconcileSourceCategoryFilter("Mods", ["Hardware"])).toBe("all");
    expect(reconcileSourceCategoryFilter("Hardware", ["Hardware"])).toBe("Hardware");
    expect(reconcileSourceCategoryFilter(UNCATEGORISED_FILTER, ["Hardware"])).toBe(
      UNCATEGORISED_FILTER,
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
    expect(matchesSourceCategoryFilter(null, UNCATEGORISED_FILTER)).toBe(true);
    expect(matchesSourceCategoryFilter("", UNCATEGORISED_FILTER)).toBe(true);
    expect(matchesSourceCategoryFilter("Mods", UNCATEGORISED_FILTER)).toBe(false);
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

  it("includes subcategories when filtering on a parent category", () => {
    expect(matchesSourceCategoryFilter("Voron/Trident", "Voron")).toBe(true);
    expect(matchesSourceCategoryFilter("Voron", "Voron")).toBe(true);
    expect(matchesSourceCategoryFilter("Voron/Trident", "Voron/Trident")).toBe(true);
    expect(matchesSourceCategoryFilter("Voron", "Voron/Trident")).toBe(false);
    expect(matchesSourceCategoryFilter("Voron 2/Trident", "Voron")).toBe(false);
  });

  it("rolls subcategory counts up into their parent", () => {
    const counts = countSourcesByCategory([
      { category: "Voron" },
      { category: "Voron/Trident" },
      { category: "Voron/Trident/Mods" },
      { category: "Toolheads" },
      { category: null },
    ]);
    expect(rollupCategoryCount(counts, "Voron")).toBe(3);
    expect(rollupCategoryCount(counts, "Voron/Trident")).toBe(2);
    expect(rollupCategoryCount(counts, "Toolheads")).toBe(1);
  });

  it("labels blank as Uncategorised", () => {
    expect(sourceCategoryLabel(null)).toBe("Uncategorised");
    expect(sourceCategoryLabel("Toolheads")).toBe("Toolheads");
  });
});
