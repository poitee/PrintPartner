import { describe, expect, it } from "vitest";
import { findDuplicateBasenames } from "./importRuleConflicts";

describe("findDuplicateBasenames", () => {
  it("returns basenames imported more than once", () => {
    expect(
      findDuplicateBasenames(["alpha/widget.stl", "beta/widget.stl", "alpha/bracket.stl"]),
    ).toEqual(["widget.stl"]);
  });

  it("returns empty when all basenames are unique", () => {
    expect(findDuplicateBasenames(["a/x.stl", "b/y.stl"])).toEqual([]);
  });
});
