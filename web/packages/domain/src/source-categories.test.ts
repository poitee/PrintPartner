import { describe, expect, it } from "vitest";
import { resolveSourceCategory } from "./source-categories.js";

describe("resolveSourceCategory", () => {
  it("reads an explicit metadata category", () => {
    expect(resolveSourceCategory(JSON.stringify({ category: "Mods" }), "base")).toBe(
      "Mods",
    );
  });

  it("treats empty metadata.category as Uncategorised (no role fallback)", () => {
    expect(resolveSourceCategory(JSON.stringify({ category: "" }), "base")).toBe(null);
    expect(resolveSourceCategory(JSON.stringify({ category: "  " }), "addon")).toBe(null);
    expect(resolveSourceCategory(JSON.stringify({ category: null }), "base")).toBe(null);
  });

  it("falls back to role when category key is absent", () => {
    expect(resolveSourceCategory(JSON.stringify({ other: 1 }), "base")).toBe(
      "Printer kits",
    );
    expect(resolveSourceCategory(null, "addon")).toBe("Mods");
    expect(resolveSourceCategory(null, "unassigned")).toBe(null);
  });
});
