import { describe, expect, it } from "vitest";
import { selectionsEqual } from "./kitManifestSave";

describe("selectionsEqual", () => {
  it("compares selection maps regardless of key order", () => {
    expect(selectionsEqual({ toolhead: "sb", probe: "tap" }, { probe: "tap", toolhead: "sb" })).toBe(
      true,
    );
    expect(selectionsEqual({ toolhead: "sb" }, { toolhead: "stock" })).toBe(false);
    expect(
      selectionsEqual(
        { extras: ["skirts", "panels"] },
        { extras: ["panels", "skirts"] },
      ),
    ).toBe(true);
    expect(selectionsEqual({ extras: "skirts" }, { extras: ["skirts"] })).toBe(true);
  });
});
