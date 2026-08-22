import { describe, expect, it } from "vitest";
import { applyOptionGroupSelections } from "./manifest-apply.js";

describe("manifest option-group selection", () => {
  it("never lets another group's patterns overwrite explicit membership", () => {
    const selected = applyOptionGroupSelections(
      [{ partKey: "shared.stl", optionGroupId: "first", included: false }],
      {
        first: {
          rule: "pick_one",
          parts: ["shared.stl"],
          variants: [{ id: "yes", parts: ["shared.stl"] }],
        },
        second: {
          rule: "pick_one",
          parts: ["shared.stl"],
          variants: [{ id: "no", parts: ["other.stl"] }],
        },
      },
      { first: "yes", second: "no" },
    );

    expect(selected).toEqual([
      { partKey: "shared.stl", optionGroupId: "first", included: true },
    ]);
  });
});
