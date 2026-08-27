import { describe, expect, it } from "vitest";
import { mergeSuggestedExcludes } from "./kit-manifest-actions.js";

describe("mergeSuggestedExcludes", () => {
  it("returns null when the apply params do not contain suggestions", () => {
    expect(mergeSuggestedExcludes(["kept.stl"], undefined)).toBeNull();
    expect(mergeSuggestedExcludes(["kept.stl"], "skip.stl")).toBeNull();
  });

  it("trims suggestions, drops blanks, and preserves existing excludes", () => {
    expect(
      mergeSuggestedExcludes(["kept.stl"], [" new.stl ", "", "kept.stl", null]),
    ).toEqual(["kept.stl", "new.stl", "null"]);
  });

  it("returns null when suggestions contain no usable path", () => {
    expect(mergeSuggestedExcludes(["kept.stl"], [" ", ""])).toBeNull();
  });
});
