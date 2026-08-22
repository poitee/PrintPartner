import { describe, expect, it } from "vitest";
import { safePlanSlug } from "./export-paths.js";

describe("accepted export paths", () => {
  it.each([".", ".."])('does not return a traversal segment for "%s"', (name) => {
    expect(safePlanSlug(name)).toBe("export");
  });
});
