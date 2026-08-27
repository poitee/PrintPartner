import { describe, expect, it } from "vitest";
import { matchesPlanningPathScope } from "./planning-path-scope.js";

describe("matchesPlanningPathScope", () => {
  it("matches exact file paths", () => {
    expect(matchesPlanningPathScope("parts/a.stl", new Set(["parts/a.stl"]))).toBe(true);
  });

  it("matches wildcard folder scopes", () => {
    expect(matchesPlanningPathScope("parts/frame/a.stl", new Set(["parts/frame/**"]))).toBe(true);
  });

  it("does not match unrelated paths", () => {
    expect(matchesPlanningPathScope("parts/toolhead/a.stl", new Set(["parts/frame/**"]))).toBe(false);
  });
});
