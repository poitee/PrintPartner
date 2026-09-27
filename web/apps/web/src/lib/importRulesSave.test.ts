import { describe, expect, it } from "vitest";
import { rulesEqual } from "./importRulesSave";

describe("rulesEqual", () => {
  it("compares rule lists regardless of order", () => {
    expect(rulesEqual(["b/", "a.stl"], ["a.stl", "b/"])).toBe(true);
  });

  it("treats folder rules with and without trailing slash as equal", () => {
    expect(rulesEqual(["parts/a"], ["parts/a/"])).toBe(true);
  });

  it("detects different rules", () => {
    expect(rulesEqual(["a.stl"], ["b.stl"])).toBe(false);
    expect(rulesEqual(["a.stl"], ["a.stl", "b.stl"])).toBe(false);
  });
});
