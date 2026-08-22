import { describe, expect, it } from "vitest";
import { parseQuantity, parseRole, parseStlPath } from "./parsers.js";

describe("parsers", () => {
  it("parses accent quantity", () => {
    const p = parseStlPath("parts/[a]_foo_x4.stl");
    expect(p.role).toBe("accent");
    expect(p.quantity).toBe(4);
    expect(p.partSlug.toLowerCase()).toContain("foo");
  });

  it("defaults primary quantity", () => {
    const p = parseStlPath("body/plate.stl");
    expect(p.role).toBe("primary");
    expect(p.quantity).toBe(1);
  });

  it("detects clear in path", () => {
    expect(parseStlPath("[c]/lens.stl").role).toBe("clear");
  });

  it("detects opaque marker", () => {
    expect(parseStlPath("shell/[o]_cover.stl").role).toBe("opaque");
  });

  it("parses space quantity variant", () => {
    expect(parseQuantity("widget x2.stl")).toBe(2);
  });

  it("parses role from filename only", () => {
    expect(parseRole("[a]bracket.stl")).toBe("accent");
  });
});
